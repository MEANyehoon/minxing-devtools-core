'use strict';
const WebSocketServer = require('ws').Server;
const Path = require('path');
const URL = require('url');
const Fse = require('fs-extra');
const EventEmitter = require('events');
const Utils = require('../utils/utils');
const Package = require('./package');
const os = require('os');

const COMMAND = {
    'HEART_BEAT': 4,
    'DOWNLOAD': 2,
    'LOG': 8
}

const moduleOptions = {
    port: null,
    tempPath: null,
    socketServer: null,
    workspace: null,
    httpServer: null,
    connectionCount: 0,
    logEmitter: new EventEmitter()
}

module.exports = {
    getLocalIp() {
        const interfaces = os.networkInterfaces();

        return Object.keys(interfaces).reduce((addr, dev)=> {
            const newAddress = interfaces[dev]
                .filter(detail => "IPv4" === detail.family && detail.address !== "127.0.0.1")
                .map(d => d.address);
            return [...addr, ...newAddress];
        }, []);
    },
    info() {
        return {
            ip: this.getLocalIp(),
            port: moduleOptions.port,
            connectionCount: moduleOptions.connectionCount
        }
    },
    start({
        tempPath,
        port = 8686
    }) {
        const server = require('http').createServer((req, res) => {
            const pathname = URL.parse(req.url).pathname;

            const zipPath = Path.join(moduleOptions.tempPath, pathname);

            if (!Fse.existsSync(zipPath)) {
                this.notFound({
                    res: res
                })
                return;
            }
            const stat = Fse.statSync(zipPath);
            res.setHeader('Accept-Ranges', 'bytes');
            if (req.headers['range']) {
                const range = Utils.parseRange(req.headers["range"], stat.size);
                if (range) {
                    res.setHeader("Content-Range", "bytes " + range.start + "-" + range.end + "/" + stat.size);
                    res.setHeader("Content-Length", (range.end - range.start + 1));
                    Fse.createReadStream(zipPath, {
                        "start": range.start,
                        "end": range.end
                    }).pipe(res);
                } else {
                    res.removeHeader("Content-Length");
                    res.writeHead(416, "Request Range Not Satisfiable");
                    res.end();
                }
            } else {
                res.setHeader('Content-Length', stat.size);
                Fse.createReadStream(zipPath).pipe(res);
            }
            
        })

        const wss = new WebSocketServer({
            server: server
        })

        moduleOptions.port = port;
        moduleOptions.socketServer = wss;
        moduleOptions.httpServer = server;
        moduleOptions.tempPath = tempPath;
        
        wss.on('connection', (socket) => {
            this.afterSocketConnect({
                socket: socket
            })
        })

        server.listen(port, () => {
            console.log(`敏行服务: ${JSON.stringify(this.getLocalIp())} port: ${server.address().port}`);
        });
    },
    end() {
        moduleOptions.socketServer.close();
        moduleOptions.httpServer.close();
        console.log("敏行 Wifi 真机同步服务 已关闭...");
    },
    afterSocketConnect({
        socket
    }) {
        moduleOptions.connectionCoun += 1;

        console.log("有设备连接")
        console.log(`当前连接设备数:${moduleOptions.connectionCount}, port:${moduleOptions.port}`)

        socket.send(JSON.stringify(this.httpPortCmd(moduleOptions.port)));

        socket.on("error", (err) => {
            // silent...
        })

        socket.on('close', () => {
            moduleOptions.connectionCount -= 1;
            console.log('有设备断开');
            console.log(`当前连接设备数:${moduleOptions.connectionCount}`)
        });

        socket.on("message", (message) => {
            let incoming = '';
            try {
                incoming = JSON.parse(message);
            } catch (e) {
                console.warn(`socket on message JSON.parse error->${e}`);
                incoming = message;
            }
            incoming.command = incoming.command - 0;

            if (incoming.command === COMMAND.HEART_BEAT) {
                let cmd = this.replyLoaderHeartbeatCmd({
                    command: incoming.command
                })
                this.sendCommand({
                    socket: socket,
                    cmd: cmd
                })
            }

            if (incoming.command === COMMAND.DOWNLOAD) {
                Package.getDownloadCmd({
                    appId: incoming.appId,
                    timestamp: incoming.timestamp,
                    workspace: moduleOptions.workspace,
                    tempPath: moduleOptions.tempPath
                })
                .then(cmd => {
                    if (cmd) {
                        this.sendCommand({
                            socket: socket,
                            cmd: cmd
                        })
                    }
                })
            }

            if (incoming.command === COMMAND.LOG) {
                this.handleLog({
                    cmd: incoming
                })
            }
        })
    },
    sync({
        project,
        updateAll
    }) { // 更新,全量或增量.

        if (typeof project !== "string") {
            console.log(`${project} 不是一个有效的文件路径`)
            return;
        }

        let projectPath = Path.resolve(project);
        let configPath = Path.resolve(projectPath, "plugin.properties");
        let workspace = Path.resolve(projectPath, "..");
        let appId = null;

        if (Fse.existsSync(configPath)) {
            const appInfo = Utils.readPropertiesSync(configPath);
            if (appInfo) {
                appId = appInfo['app_id'];
            }
        }

        if (!appId) {
            console.log(`${project} 似乎不是一个有效的敏行项目`);
            return;
        }

        moduleOptions.workspace = workspace;

        const cmd = this.syncCmd({
            appId: appId,
            updateAll: updateAll
        });
        this.broadcastCommand({
            socketServer: moduleOptions.socketServer,
            cmd: cmd
        })
    },
    preview({
        file
    }) { // 页面实时预览.
        if (typeof file !== "string") {
            console.log(`${file} 不是一个有效的文件路径`)
            return
        }
        file = Path.resolve(file);

        const {
            app_id,
            project
        } = Utils.fetchProjectRootInfoByFile(file)

        if (!app_id) {
            console.log(`${file} 似乎不在有效的敏行项目中`)
            return
        }

        moduleOptions.workspace = Path.resolve(project, "..")

        const cmd = this.previewCmd({
            file: file,
            workspace: moduleOptions.workspace,
            appId: app_id
        })
        this.broadcastCommand({
            socketServer: moduleOptions.socketServer,
            cmd: cmd
        })
    },
    broadcastCommand({
        socketServer,
        cmd
    }) {
        socketServer.clients.forEach((socket) => {
            this.sendCommand({
                socket: socket,
                cmd: cmd
            })
        })
    },
    sendCommand({
        socket,
        cmd
    }) {
        let cmdStr = JSON.stringify(cmd)
        socket.send(cmdStr, (error) => {
            if (error) {
                console.warn(`Socket send message error->${error}`);
            }
        })
    },
    log(callback) {
        return new Promise(resolve => {
            this.on("log", log => {
                callback(log);
                resolve();
            })
        })
    },
    handleLog({
        cmd
    }) {
        moduleOptions.logEmitter.emit('log', {
            content: cmd.content,
            level: cmd.level
        })
    },
    on(event, callback) {
        moduleOptions.logEmitter.on(event, callback)
    },
    syncCmd({
        appId,
        updateAll = true
    }) { 
        return {
            command: 1,
            appId: appId,
            updateAll: updateAll,
        }
    },
    replyLoaderHeartbeatCmd({
        command
    }) {
        return {
            command: command
        }
    },
    previewCmd({
        file,
        workspace,
        appId
    }) { // 发送‘页面实时预览’指令
        let absoluteUrlPath = this.absoluteUrlPath({
            file: file,
            workspace: workspace,
            appId: appId
        })

        return {
            command: 6,
            path: absoluteUrlPath,
            appId: appId
        }
    },
    httpPortCmd({
        port
    }) { // 返回 http 端口信息.
        return {
            command: 7,
            port: port
        }
    },
    absoluteUrlPath({
        file,
        workspace,
        appId
    }) { // 本地文件对应的服务器地址.
        let relativePath = Path.relative(workspace, file)
        relativePath = relativePath.replace(/\\/g, "/")
        let absoluteUrlPath = `/${relativePath.replace(/^[^\/]*/,appId)}`
        return absoluteUrlPath
    },
    notFound({
        res
    }) { // 404
        res.writeHead(404, {
            "Content-Type": "text/plain"
        })
        res.write("404 Not found")
        res.end()
    }
}