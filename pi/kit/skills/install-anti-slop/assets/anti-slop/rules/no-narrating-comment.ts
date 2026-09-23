import { defineRule } from "@oxlint/plugins";

import {
	commentBlocks,
	DEFAULT_NARRATING_OPENERS,
	narratingOpener,
	narratingOpeners,
} from "../shared/comment-blocks.ts";

/** Reject a comment that opens by narrating the code instead of saying why it exists. */
export const noNarratingCommentRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Reject comments opening with narration such as `This function`, `Here we` or `Note that`. Licence headers, lint directives and SAFETY justifications are exempt.",
		},
		messages: {
			narratingComment:
				'This comment opens with "{{opener}}", which narrates what the code does. Say why it exists or is shaped this way, or delete it: code is the truth.',
		},
		schema: [
			{
				type: "object",
				properties: {
					openers: {
						type: "array",
						items: { type: "string", minLength: 1 },
						minItems: 1,
						uniqueItems: true,
					},
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ openers: [...DEFAULT_NARRATING_OPENERS] }],
	},
	createOnce(context) {
		return {
			Program() {
				const openers = narratingOpeners(context.options?.[0]);
				for (const block of commentBlocks(context.sourceCode.getAllComments())) {
					const opener = narratingOpener(block, openers);
					if (opener === undefined) continue;
					context.report({
						loc: { line: block.startLine, column: block.startColumn },
						messageId: "narratingComment",
						data: { opener },
					});
				}
			},
		};
	},
});
