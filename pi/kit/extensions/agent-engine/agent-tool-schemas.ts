import { Type } from "typebox";
import { SEND_MESSAGE_PARAMS } from "../../lib/agents/agent-tool-text.ts";

export const sendMessageParams = Type.Object({
	to: Type.String({ description: SEND_MESSAGE_PARAMS.to }),
	message: Type.String({ description: SEND_MESSAGE_PARAMS.message }),
	interrupt: Type.Optional(Type.Boolean({ description: SEND_MESSAGE_PARAMS.interrupt, default: false })),
});

export const listAgentsParams = Type.Object({});
