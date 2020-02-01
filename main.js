// https://tools.ietf.org/html/rfc1928
const net = require('net');

const SOCKS5_INFO = '_socks5Info';

const log = {};
log.info = function(...args) {
    console.log(new Date().toISOString(), ...args);
}
log.error = function(...args) {
    console.error(new Date().toISOString(), ...args);
}

/** server state enumeration per connection */
const stateEnum = {
    uninited: 1,
    methodSelected: 2,
    /** todo: username/password state, etc. */
    reqReceived: 3,
    cmdReplied: 4,
};

const stateTrans = {
    [stateEnum.uninited]: uninitedHandler,
    [stateEnum.methodSelected]: methodSelectedHandler,
    [stateEnum.cmdReplied]: cmdRepliedHandler,
};

/**
    +----+----------+----------+
    |VER | NMETHODS | METHODS  |
    +----+----------+----------+
    | 1  |    1     | 1 to 255 |
    +----+----------+----------+
 * @param {*} buf 
 * @param {*} conn 
 */
function uninitedHandler(buf, conn) {
    // require sound connection request data
    if (
        buf[0] !== 0x5 || 
        buf.length < 2 ||
        buf[1] === 0 || 
        (buf.length !== buf[1] + 2)
    ) {
        log.error(`connection data request illegal:`, buf);
        conn.destroy();
        return;
    }

    const methodsNum = buf[1];
    for (let i = 0; i < methodsNum; ++i) {
        if (buf[i + 2] === 0) {
            conn.write(Buffer.from([5, 0]));
            conn[SOCKS5_INFO] = {
                state: stateEnum.methodSelected,
                buf: undefined,
            };
            return;
        }
    }

    log.error(`no allowed methods:`, buf);
}
/**
    +----+-----+-------+------+----------+----------+
    |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
    +----+-----+-------+------+----------+----------+
    | 1  |  1  | X'00' |  1   | Variable |    2     |
    +----+-----+-------+------+----------+----------+
 * @param {*} buf 
 * @param {*} conn 
 */
function methodSelectedHandler(buf, conn) {
    if (buf[0] !== 5) {
        log.error(`req version error:`, buf);
        conn.destroy();
        return;
    }

    if (buf[1] !== 1) {
        log.error(`cmd:${buf[1]} not supported`);
        conn.destroy();
        return;
    }

    try {
        let dstAddr = '';
        let dstPort = 0;
        switch (buf[3]) {
            case 1: {
                dstAddr = [buf[4], buf[5], buf[6], buf[7]].join(',');
                dstPort = (buf[8] << 8) | buf[9];
                break;
            }
            case 3: {
                const domainLen = buf[4];
                dstAddr = buf.slice(5, domainLen + 5).toString();
                dstPort = buf[domainLen + 5] << 8 | buf[domainLen + 6];
                break;
            }
            case 4: 
            default: {
                log.error(`error or ipv6 not supported yet:`, buf);
                conn.destroy();
                return;
            }
        }

        const relaySocket = net.createConnection(
            {
                port: dstPort,
                host: dstAddr,
            },
            () => {
                let ret = [5, 0, 0, 1];
                ret = ret.concat(relaySocket.localAddress.split('.').map((str) => +str));
                ret = ret.concat(relaySocket.localPort >> 8, relaySocket.localPort & 255);
                conn.write(Buffer.from(ret));
                conn[SOCKS5_INFO] = {
                    state: stateEnum.cmdReplied,
                    relaySocket,
                };

                relaySocket.on('data', (relayBuf) => {
                    conn.write(relayBuf);
                });
            }
        );

        relaySocket.on('error', (e) => {
            log.error(`create relay socket failed:${e}`);
            conn.destroy();
            relaySocket.destroy();
        });
    } catch (e) {
        log.error(e, `error cmd req:`, buf);
        conn.destroy();
    }
}
function cmdRepliedHandler(buf, conn) {
    conn[SOCKS5_INFO].relaySocket.write(buf);
}

function socks5DataHandler(buf, conn) {
    // console.log.info('data:', buf);
    const handler = stateTrans[conn[SOCKS5_INFO].state];
    if (handler) {
        handler(buf, conn);
    } else {
        // todo
    }
}

const server = net.createServer((c) => {
    log.info(`${c.remoteAddress}:${c.remotePort} connected`);

    c[SOCKS5_INFO] = {
        state: stateEnum.uninited,
    };

    c.on('end', () => {
        log.info(`${c.remoteAddress}:${c.remotePort} ended`);
    })
    .on('error', (e) => {
        log.error(`connnection errored:${e}, ${c.remoteAddress}:${c.remotePort}`);
        const { relaySocket } = c[SOCKS5_INFO];
        if (relaySocket) {
            relaySocket.destroy();
        }
    });

    c.on('data', (buf) => {
        socks5DataHandler(buf, c);
    });
});

server.on('error', (e) => {
    log.error(`server error:${e}`);
});

server.listen(8124, () => {
    log.info('listening');
});