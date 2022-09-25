"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeMessagesRecvSocket = void 0;
const WAProto_1 = require("../../WAProto");
const Defaults_1 = require("../Defaults");
const Types_1 = require("../Types");
const Utils_1 = require("../Utils");
const make_mutex_1 = require("../Utils/make-mutex");
const WABinary_1 = require("../WABinary");
const chats_1 = require("./chats");
const groups_1 = require("./groups");
const STATUS_MAP = {
    'played': WAProto_1.proto.WebMessageInfo.WebMessageInfoStatus.PLAYED,
    'read': WAProto_1.proto.WebMessageInfo.WebMessageInfoStatus.READ,
    'read-self': WAProto_1.proto.WebMessageInfo.WebMessageInfoStatus.READ
};
const getStatusFromReceiptType = (type) => {
    const status = STATUS_MAP[type];
    if (typeof type === 'undefined') {
        return WAProto_1.proto.WebMessageInfo.WebMessageInfoStatus.DELIVERY_ACK;
    }
    return status;
};
const makeMessagesRecvSocket = (config) => {
    const { logger } = config;
    const sock = chats_1.makeChatsSocket(config);
    const { ev, authState, ws, assertSessions, assertingPreKeys, sendNode, relayMessage, sendReceipt, resyncMainAppState, } = sock;
    /** this mutex ensures that the notifications (receipts, messages etc.) are processed in order */
    const processingMutex = make_mutex_1.makeKeyedMutex();
    /** this mutex ensures that each retryRequest will wait for the previous one to finish */
    const retryMutex = make_mutex_1.makeMutex();
    const msgRetryMap = config.msgRetryCounterMap || {};
    const historyCache = new Set();
    const sendMessageAck = async ({ tag, attrs }, extraAttrs) => {
        const stanza = {
            tag: 'ack',
            attrs: {
                id: attrs.id,
                to: attrs.from,
                ...extraAttrs,
            }
        };
        if (!!attrs.participant) {
            stanza.attrs.participant = attrs.participant;
        }
        logger.debug({ recv: attrs, sent: stanza.attrs }, `sent "${tag}" ack`);
        await sendNode(stanza);
    };
    const sendRetryRequest = async (node) => {
        const msgId = node.attrs.id;
        const retryCount = msgRetryMap[msgId] || 1;
        if (retryCount >= 5) {
            logger.debug({ retryCount, msgId }, 'reached retry limit, clearing');
            delete msgRetryMap[msgId];
            return;
        }
        msgRetryMap[msgId] = retryCount + 1;
        const isGroup = !!node.attrs.participant;
        const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds;
        const deviceIdentity = WAProto_1.proto.ADVSignedDeviceIdentity.encode(account).finish();
        await assertingPreKeys(1, async (preKeys) => {
            const [keyId] = Object.keys(preKeys);
            const key = preKeys[+keyId];
            const decFrom = node.attrs.from ? WABinary_1.jidDecode(node.attrs.from) : undefined;
            const receipt = {
                tag: 'receipt',
                attrs: {
                    id: msgId,
                    type: 'retry',
                    to: isGroup ? node.attrs.from : WABinary_1.jidEncode(decFrom.user, 's.whatsapp.net', decFrom.device, 0)
                },
                content: [
                    {
                        tag: 'retry',
                        attrs: {
                            count: retryCount.toString(),
                            id: node.attrs.id,
                            t: node.attrs.t,
                            v: '1'
                        }
                    },
                    {
                        tag: 'registration',
                        attrs: {},
                        content: Utils_1.encodeBigEndian(authState.creds.registrationId)
                    }
                ]
            };
            if (node.attrs.recipient) {
                receipt.attrs.recipient = node.attrs.recipient;
            }
            if (node.attrs.participant) {
                receipt.attrs.participant = node.attrs.participant;
            }
            if (retryCount > 1) {
                const exec = Utils_1.generateSignalPubKey(Buffer.from(Defaults_1.KEY_BUNDLE_TYPE)).slice(0, 1);
                receipt.content.push({
                    tag: 'keys',
                    attrs: {},
                    content: [
                        { tag: 'type', attrs: {}, content: exec },
                        { tag: 'identity', attrs: {}, content: identityKey.public },
                        Utils_1.xmppPreKey(key, +keyId),
                        Utils_1.xmppSignedPreKey(signedPreKey),
                        { tag: 'device-identity', attrs: {}, content: deviceIdentity }
                    ]
                });
            }
            await sendNode(receipt);
            logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt');
        });
    };
    const processMessage = async (message, chatUpdate) => {
        var _a;
        const protocolMsg = (_a = message.message) === null || _a === void 0 ? void 0 : _a.protocolMessage;
        if (protocolMsg) {
            switch (protocolMsg.type) {
                case WAProto_1.proto.ProtocolMessage.ProtocolMessageType.HISTORY_SYNC_NOTIFICATION:
                    const histNotification = protocolMsg.historySyncNotification;
                    logger.info({ histNotification, id: message.key.id }, 'got history notification');
                    const { chats, contacts, messages, isLatest } = await Utils_1.downloadAndProcessHistorySyncNotification(histNotification, historyCache);
                    const meJid = authState.creds.me.id;
                    await sendNode({
                        tag: 'receipt',
                        attrs: {
                            id: message.key.id,
                            type: 'hist_sync',
                            to: WABinary_1.jidEncode(WABinary_1.jidDecode(meJid).user, 'c.us')
                        }
                    });
                    if (chats.length) {
                        ev.emit('chats.set', { chats, isLatest });
                    }
                    if (messages.length) {
                        ev.emit('messages.set', { messages, isLatest });
                    }
                    if (contacts.length) {
                        ev.emit('contacts.set', { contacts });
                    }
                    break;
                case WAProto_1.proto.ProtocolMessage.ProtocolMessageType.APP_STATE_SYNC_KEY_SHARE:
                    const keys = protocolMsg.appStateSyncKeyShare.keys;
                    if (keys === null || keys === void 0 ? void 0 : keys.length) {
                        let newAppStateSyncKeyId = '';
                        for (const { keyData, keyId } of keys) {
                            const strKeyId = Buffer.from(keyId.keyId).toString('base64');
                            logger.info({ strKeyId }, 'injecting new app state sync key');
                            await authState.keys.set({ 'app-state-sync-key': { [strKeyId]: keyData } });
                            newAppStateSyncKeyId = strKeyId;
                        }
                        ev.emit('creds.update', { myAppStateKeyId: newAppStateSyncKeyId });
                        resyncMainAppState();
                    }
                    else {
                        [
                            logger.info({ protocolMsg }, 'recv app state sync with 0 keys')
                        ];
                    }
                    break;
                case WAProto_1.proto.ProtocolMessage.ProtocolMessageType.REVOKE:
                    ev.emit('messages.update', [
                        {
                            key: {
                                ...message.key,
                                id: protocolMsg.key.id
                            },
                            update: { message: null, messageStubType: Types_1.WAMessageStubType.REVOKE, key: message.key }
                        }
                    ]);
                    break;
                case WAProto_1.proto.ProtocolMessage.ProtocolMessageType.EPHEMERAL_SETTING:
                    chatUpdate.ephemeralSettingTimestamp = Utils_1.toNumber(message.messageTimestamp);
                    chatUpdate.ephemeralExpiration = protocolMsg.ephemeralExpiration || null;
                    break;
            }
        }
        else if (message.messageStubType) {
            const meJid = authState.creds.me.id;
            const jid = message.key.remoteJid;
            //let actor = whatsappID (message.participant)
            let participants;
            const emitParticipantsUpdate = (action) => (ev.emit('group-participants.update', { id: jid, participants, action }));
            const emitGroupUpdate = (update) => {
                ev.emit('groups.update', [{ id: jid, ...update }]);
            };
            switch (message.messageStubType) {
                case Types_1.WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
                case Types_1.WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
                    participants = message.messageStubParameters;
                    emitParticipantsUpdate('remove');
                    // mark the chat read only if you left the group
                    if (participants.includes(meJid)) {
                        chatUpdate.readOnly = true;
                    }
                    break;
                case Types_1.WAMessageStubType.GROUP_PARTICIPANT_ADD:
                case Types_1.WAMessageStubType.GROUP_PARTICIPANT_INVITE:
                case Types_1.WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
                    participants = message.messageStubParameters;
                    if (participants.includes(meJid)) {
                        chatUpdate.readOnly = false;
                    }
                    emitParticipantsUpdate('add');
                    break;
                case Types_1.WAMessageStubType.GROUP_CHANGE_ANNOUNCE:
                    const announceValue = message.messageStubParameters[0];
                    emitGroupUpdate({ announce: announceValue === 'true' || announceValue === 'on' });
                    break;
                case Types_1.WAMessageStubType.GROUP_CHANGE_RESTRICT:
                    const restrictValue = message.messageStubParameters[0];
                    emitGroupUpdate({ restrict: restrictValue === 'true' || restrictValue === 'on' });
                    break;
                case Types_1.WAMessageStubType.GROUP_CHANGE_SUBJECT:
                    chatUpdate.name = message.messageStubParameters[0];
                    emitGroupUpdate({ subject: chatUpdate.name });
                    break;
            }
        }
    };
    const processNotification = (node) => {
        const result = {};
        const [child] = WABinary_1.getAllBinaryNodeChildren(node);
        if (node.attrs.type === 'w:gp2') {
            switch (child === null || child === void 0 ? void 0 : child.tag) {
                case 'create':
                    const metadata = groups_1.extractGroupMetadata(child);
                    result.messageStubType = Types_1.WAMessageStubType.GROUP_CREATE;
                    result.messageStubParameters = [metadata.subject];
                    result.key = { participant: metadata.owner };
                    ev.emit('chats.upsert', [{
                            id: metadata.id,
                            name: metadata.subject,
                            conversationTimestamp: metadata.creation,
                        }]);
                    ev.emit('groups.upsert', [metadata]);
                    break;
                case 'ephemeral':
                case 'not_ephemeral':
                    result.message = {
                        protocolMessage: {
                            type: WAProto_1.proto.ProtocolMessage.ProtocolMessageType.EPHEMERAL_SETTING,
                            ephemeralExpiration: +(child.attrs.expiration || 0)
                        }
                    };
                    break;
                case 'promote':
                case 'demote':
                case 'remove':
                case 'add':
                case 'leave':
                    const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`;
                    result.messageStubType = Types_1.WAMessageStubType[stubType];
                    const participants = WABinary_1.getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid);
                    if (participants.length === 1 &&
                        // if recv. "remove" message and sender removed themselves
                        // mark as left
                        WABinary_1.areJidsSameUser(participants[0], node.attrs.participant) &&
                        child.tag === 'remove') {
                        result.messageStubType = Types_1.WAMessageStubType.GROUP_PARTICIPANT_LEAVE;
                    }
                    result.messageStubParameters = participants;
                    break;
                case 'subject':
                    result.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_SUBJECT;
                    result.messageStubParameters = [child.attrs.subject];
                    break;
                case 'announcement':
                case 'not_announcement':
                    result.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_ANNOUNCE;
                    result.messageStubParameters = [(child.tag === 'announcement') ? 'on' : 'off'];
                    break;
                case 'locked':
                case 'unlocked':
                    result.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_RESTRICT;
                    result.messageStubParameters = [(child.tag === 'locked') ? 'on' : 'off'];
                    break;
            }
        }
        else {
            switch (child.tag) {
                case 'devices':
                    const devices = WABinary_1.getBinaryNodeChildren(child, 'device');
                    if (WABinary_1.areJidsSameUser(child.attrs.jid, authState.creds.me.id)) {
                        const deviceJids = devices.map(d => d.attrs.jid);
                        logger.info({ deviceJids }, 'got my own devices');
                    }
                    break;
            }
        }
        if (Object.keys(result).length) {
            return result;
        }
    };
    // recv a message
    ws.on('CB:message', (stanza) => {
        const { fullMessage: msg, decryptionTask } = Utils_1.decodeMessageStanza(stanza, authState);
        processingMutex.mutex(msg.key.remoteJid, async () => {
            await decryptionTask;
            // message failed to decrypt
            if (msg.messageStubType === WAProto_1.proto.WebMessageInfo.WebMessageInfoStubType.CIPHERTEXT) {
                logger.error({ msgId: msg.key.id, params: msg.messageStubParameters }, 'failure in decrypting message');
                retryMutex.mutex(async () => await sendRetryRequest(stanza));
            }
            else {
                await sendMessageAck(stanza, { class: 'receipt' });
                // no type in the receipt => message delivered
                await sendReceipt(msg.key.remoteJid, msg.key.participant, [msg.key.id], undefined);
                logger.debug({ msg: msg.key }, 'sent delivery receipt');
            }
            msg.key.remoteJid = WABinary_1.jidNormalizedUser(msg.key.remoteJid);
            ev.emit('messages.upsert', { messages: [msg], type: stanza.attrs.offline ? 'append' : 'notify' });
        });
    });
    ws.on('CB:ack,class:message', async (node) => {
        await sendNode({
            tag: 'ack',
            attrs: {
                class: 'receipt',
                id: node.attrs.id,
                from: node.attrs.from
            }
        });
        logger.debug({ attrs: node.attrs }, 'sending receipt for ack');
    });
    ws.on('CB:call', async (node) => {
        logger.info({ node }, 'recv call');
        const [child] = WABinary_1.getAllBinaryNodeChildren(node);
        if (!!(child === null || child === void 0 ? void 0 : child.tag)) {
            await sendMessageAck(node, { class: 'call', type: child.tag });
        }
    });
    const sendMessagesAgain = async (key, ids) => {
        const msgs = await Promise.all(ids.map(id => (config.getMessage({ ...key, id }))));
        const participant = key.participant || key.remoteJid;
        await assertSessions([participant], true);
        if (WABinary_1.isJidGroup(key.remoteJid)) {
            await authState.keys.set({ 'sender-key-memory': { [key.remoteJid]: null } });
        }
        logger.debug({ participant }, 'forced new session for retry recp');
        for (let i = 0; i < msgs.length; i++) {
            if (msgs[i]) {
                await relayMessage(key.remoteJid, msgs[i], {
                    messageId: ids[i],
                    participant
                });
            }
            else {
                logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available');
            }
        }
    };
    const handleReceipt = async (node) => {
        var _a;
        let shouldAck = true;
        const { attrs, content } = node;
        const isNodeFromMe = WABinary_1.areJidsSameUser(attrs.participant || attrs.from, (_a = authState.creds.me) === null || _a === void 0 ? void 0 : _a.id);
        const remoteJid = !isNodeFromMe || WABinary_1.isJidGroup(attrs.from) ? attrs.from : attrs.recipient;
        const fromMe = !attrs.recipient;
        const ids = [attrs.id];
        if (Array.isArray(content)) {
            const items = WABinary_1.getBinaryNodeChildren(content[0], 'item');
            ids.push(...items.map(i => i.attrs.id));
        }
        const key = {
            remoteJid,
            id: '',
            fromMe,
            participant: attrs.participant
        };
        await processingMutex.mutex(remoteJid, async () => {
            const status = getStatusFromReceiptType(attrs.type);
            if (typeof status !== 'undefined' &&
                (
                // basically, we only want to know when a message from us has been delivered to/read by the other person
                // or another device of ours has read some messages
                status > WAProto_1.proto.WebMessageInfo.WebMessageInfoStatus.DELIVERY_ACK ||
                    !isNodeFromMe)) {
                if (WABinary_1.isJidGroup(remoteJid)) {
                    const updateKey = status === WAProto_1.proto.WebMessageInfo.WebMessageInfoStatus.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp';
                    ev.emit('message-receipt.update', ids.map(id => ({
                        key: { ...key, id },
                        receipt: {
                            userJid: WABinary_1.jidNormalizedUser(attrs.participant),
                            [updateKey]: +attrs.t
                        }
                    })));
                }
                else {
                    ev.emit('messages.update', ids.map(id => ({
                        key: { ...key, id },
                        update: { status }
                    })));
                }
            }
            if (attrs.type === 'retry') {
                // correctly set who is asking for the retry
                key.participant = key.participant || attrs.from;
                if (key.fromMe) {
                    try {
                        logger.debug({ attrs }, 'recv retry request');
                        await sendMessagesAgain(key, ids);
                    }
                    catch (error) {
                        logger.error({ key, ids, trace: error.stack }, 'error in sending message again');
                        shouldAck = false;
                    }
                }
                else {
                    logger.info({ attrs, key }, 'recv retry for not fromMe message');
                }
            }
            if (shouldAck) {
                await sendMessageAck(node, { class: 'receipt', type: attrs.type });
            }
        });
    };
    ws.on('CB:receipt', handleReceipt);
    ws.on('CB:notification', async (node) => {
        const remoteJid = node.attrs.from;
        processingMutex.mutex(remoteJid, () => {
            const msg = processNotification(node);
            if (msg) {
                const fromMe = WABinary_1.areJidsSameUser(node.attrs.participant || node.attrs.from, authState.creds.me.id);
                msg.key = {
                    remoteJid: node.attrs.from,
                    fromMe,
                    participant: node.attrs.participant,
                    id: node.attrs.id,
                    ...(msg.key || {})
                };
                msg.messageTimestamp = +node.attrs.t;
                const fullMsg = WAProto_1.proto.WebMessageInfo.fromObject(msg);
                ev.emit('messages.upsert', { messages: [fullMsg], type: 'append' });
            }
        });
        await sendMessageAck(node, { class: 'notification', type: node.attrs.type });
    });
    ev.on('messages.upsert', async ({ messages, type }) => {
        var _a;
        if (type === 'notify' || type === 'append') {
            const chat = { id: messages[0].key.remoteJid };
            const contactNameUpdates = {};
            for (const msg of messages) {
                if (!!msg.pushName) {
                    const jid = msg.key.fromMe ? WABinary_1.jidNormalizedUser(authState.creds.me.id) : (msg.key.participant || msg.key.remoteJid);
                    contactNameUpdates[jid] = msg.pushName;
                    // update our pushname too
                    if (msg.key.fromMe && ((_a = authState.creds.me) === null || _a === void 0 ? void 0 : _a.name) !== msg.pushName) {
                        ev.emit('creds.update', { me: { ...authState.creds.me, name: msg.pushName } });
                    }
                }
                await processingMutex.mutex('p-' + chat.id, () => processMessage(msg, chat));
                if (!!msg.message && !msg.message.protocolMessage) {
                    chat.conversationTimestamp = Utils_1.toNumber(msg.messageTimestamp);
                    if (!msg.key.fromMe) {
                        chat.unreadCount = (chat.unreadCount || 0) + 1;
                    }
                }
            }
            if (Object.keys(chat).length > 1) {
                ev.emit('chats.update', [chat]);
            }
            if (Object.keys(contactNameUpdates).length) {
                ev.emit('contacts.update', Object.keys(contactNameUpdates).map(id => ({ id, notify: contactNameUpdates[id] })));
            }
        }
    });
    return { ...sock, processMessage, sendMessageAck, sendRetryRequest };
};
exports.makeMessagesRecvSocket = makeMessagesRecvSocket;
