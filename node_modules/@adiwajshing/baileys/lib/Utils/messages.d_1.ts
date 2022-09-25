import { proto } from '../../WAProto';
import { AnyMediaMessageContent, AnyMessageContent, MediaGenerationOptions, MessageContentGenerationOptions, MessageGenerationOptions, MessageGenerationOptionsFromContent, MessageUserReceipt, WAMessage, WAMessageContent, WAProto } from '../Types';
export declare const prepareWAMessageMedia: (message: AnyMediaMessageContent, options: MediaGenerationOptions) => Promise<proto.Message>;
export declare const prepareDisappearingMessageSettingContent: (ephemeralExpiration?: number) => proto.Message;
/**
 * Generate forwarded message content like WA does
 * @param message the message to forward
 * @param options.forceForward will show the message as forwarded even if it is from you
 */
export declare const generateForwardMessageContent: (message: WAMessage, forceForward?: boolean) => proto.IMessage;
export declare const generateWAMessageContent: (message: AnyMessageContent, options: MessageContentGenerationOptions) => Promise<proto.Message>;
export declare const generateWAMessageFromContent: (jid: string, message: WAMessageContent, options: MessageGenerationOptionsFromContent) => proto.WebMessageInfo;
export declare const generateWAMessage: (jid: string, content: AnyMessageContent, options: MessageGenerationOptions) => Promise<proto.WebMessageInfo>;
/** Get the key to access the true type of content */
export declare const getContentType: (content: WAProto.IMessage | undefined) => keyof proto.IMessage;
/**
 * Extract the true message content from a message
 * Eg. extracts the inner message from a disappearing message/view once message
 */
export declare const extractMessageContent: (content: WAMessageContent | undefined | null) => WAMessageContent | undefined;
/**
 * Returns the device predicted by message ID
 */
export declare const getDevice: (id: string) => "android" | "web" | "ios";
export declare const updateMessageWithReceipt: (msg: WAMessage, receipt: MessageUserReceipt) => void;
