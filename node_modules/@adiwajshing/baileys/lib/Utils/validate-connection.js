"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureSuccessfulPairing = exports.generateRegistrationNode = exports.generateLoginNode = void 0;
const boom_1 = require("@hapi/boom");
const WAProto_1 = require("../../WAProto");
const WABinary_1 = require("../WABinary");
const crypto_1 = require("./crypto");
const generics_1 = require("./generics");
const signal_1 = require("./signal");
const ENCODED_VERSION = 'S9Kdc4pc4EJryo21snc5cg==';
const getUserAgent = ({ version, browser }) => ({
    appVersion: {
        primary: version[0],
        secondary: version[1],
        tertiary: version[2],
    },
    platform: 14,
    releaseChannel: 0,
    mcc: '000',
    mnc: '000',
    osVersion: browser[2],
    manufacturer: '',
    device: browser[1],
    osBuildNumber: '0.1',
    localeLanguageIso6391: 'en',
    localeCountryIso31661Alpha2: 'en',
});
const generateLoginNode = (userJid, config) => {
    const { user, device } = WABinary_1.jidDecode(userJid);
    const payload = {
        passive: true,
        connectType: 1,
        connectReason: 1,
        userAgent: getUserAgent(config),
        webInfo: { webSubPlatform: 0 },
        username: parseInt(user, 10),
        device: device,
    };
    return WAProto_1.proto.ClientPayload.encode(payload).finish();
};
exports.generateLoginNode = generateLoginNode;
const generateRegistrationNode = ({ registrationId, signedPreKey, signedIdentityKey }, config) => {
    const appVersionBuf = new Uint8Array(Buffer.from(ENCODED_VERSION, 'base64'));
    const companion = {
        os: config.browser[0],
        version: {
            primary: 10,
            secondary: undefined,
            tertiary: undefined,
        },
        platformType: 1,
        requireFullSync: false,
    };
    const companionProto = WAProto_1.proto.CompanionProps.encode(companion).finish();
    const registerPayload = {
        connectReason: 1,
        connectType: 1,
        passive: false,
        regData: {
            buildHash: appVersionBuf,
            companionProps: companionProto,
            eRegid: generics_1.encodeInt(4, registrationId),
            eKeytype: generics_1.encodeInt(1, 5),
            eIdent: signedIdentityKey.public,
            eSkeyId: generics_1.encodeInt(3, signedPreKey.keyId),
            eSkeyVal: signedPreKey.keyPair.public,
            eSkeySig: signedPreKey.signature,
        },
        userAgent: getUserAgent(config),
        webInfo: {
            webSubPlatform: 0,
        },
    };
    return WAProto_1.proto.ClientPayload.encode(registerPayload).finish();
};
exports.generateRegistrationNode = generateRegistrationNode;
const configureSuccessfulPairing = (stanza, { advSecretKey, signedIdentityKey, signalIdentities }) => {
    var _a, _b, _c, _d, _e;
    const [pair] = WABinary_1.getAllBinaryNodeChildren(stanza);
    const pairContent = Array.isArray(pair.content) ? pair.content : [];
    const msgId = stanza.attrs.id;
    const deviceIdentity = (_a = pairContent.find(m => m.tag === 'device-identity')) === null || _a === void 0 ? void 0 : _a.content;
    const businessName = (_c = (_b = pairContent.find(m => m.tag === 'biz')) === null || _b === void 0 ? void 0 : _b.attrs) === null || _c === void 0 ? void 0 : _c.name;
    const verifiedName = businessName || '';
    const jid = (_e = (_d = pairContent.find(m => m.tag === 'device')) === null || _d === void 0 ? void 0 : _d.attrs) === null || _e === void 0 ? void 0 : _e.jid;
    const { details, hmac } = WAProto_1.proto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentity);
    const advSign = crypto_1.hmacSign(details, Buffer.from(advSecretKey, 'base64'));
    if (Buffer.compare(hmac, advSign) !== 0) {
        throw new boom_1.Boom('Invalid pairing');
    }
    const account = WAProto_1.proto.ADVSignedDeviceIdentity.decode(details);
    const { accountSignatureKey, accountSignature } = account;
    const accountMsg = WABinary_1.Binary.build(new Uint8Array([6, 0]), account.details, signedIdentityKey.public).readByteArray();
    if (!crypto_1.Curve.verify(accountSignatureKey, accountMsg, accountSignature)) {
        throw new boom_1.Boom('Failed to verify account signature');
    }
    const deviceMsg = WABinary_1.Binary.build(new Uint8Array([6, 1]), account.details, signedIdentityKey.public, account.accountSignatureKey).readByteArray();
    account.deviceSignature = crypto_1.Curve.sign(signedIdentityKey.private, deviceMsg);
    const identity = signal_1.createSignalIdentity(jid, accountSignatureKey);
    const keyIndex = WAProto_1.proto.ADVDeviceIdentity.decode(account.details).keyIndex;
    const accountEnc = WAProto_1.proto.ADVSignedDeviceIdentity.encode({
        ...account.toJSON(),
        accountSignatureKey: undefined
    }).finish();
    const reply = {
        tag: 'iq',
        attrs: {
            to: WABinary_1.S_WHATSAPP_NET,
            type: 'result',
            id: msgId,
        },
        content: [
            {
                tag: 'pair-device-sign',
                attrs: {},
                content: [
                    { tag: 'device-identity', attrs: { 'key-index': `${keyIndex}` }, content: accountEnc }
                ]
            }
        ]
    };
    const authUpdate = {
        account,
        me: { id: jid, verifiedName },
        signalIdentities: [...(signalIdentities || []), identity]
    };
    return {
        creds: authUpdate,
        reply
    };
};
exports.configureSuccessfulPairing = configureSuccessfulPairing;
