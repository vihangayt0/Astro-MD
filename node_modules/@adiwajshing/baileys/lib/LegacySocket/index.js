"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Defaults_1 = require("../Defaults");
const groups_1 = __importDefault(require("./groups"));
// export the last socket layer
const makeLegacySocket = (config) => (groups_1.default({
    ...Defaults_1.DEFAULT_LEGACY_CONNECTION_CONFIG,
    ...config
}));
exports.default = makeLegacySocket;
