"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Defaults_1 = require("../Defaults");
const messages_recv_1 = require("./messages-recv");
// export the last socket layer
const makeWASocket = (config) => (messages_recv_1.makeMessagesRecvSocket({
    ...Defaults_1.DEFAULT_CONNECTION_CONFIG,
    ...config
}));
exports.default = makeWASocket;
