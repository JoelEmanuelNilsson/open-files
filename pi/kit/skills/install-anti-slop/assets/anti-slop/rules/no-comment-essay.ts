import { defineRule } from "@oxlint/plugins";

import { commentBlocks, commentLineCap, DEFAULT_MAX_COMMENT_LINES } from "../shared/comment-blocks.ts";

/** Cap a comment block at three lines of prose, so an explanation cannot become an essay. */
export const noCommentEssayRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Cap one comment block at three lines of prose. Licence headers, lint directives and SAFETY justifications are exempt.",
		},
		messages: {
			commentEssay:
				"This comment block runs {{lines}} lines of prose and the cap is {{max}}. Keep a one-line JSDoc on the export, or one to two lines of why the code is shaped this way, and delete the rest: code is the truth.",
		},
		schema: [
			{
				type: "object",
				properties: {
					maxLines: { type: "integer", minimum: 1 },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ maxLines: DEFAULT_MAX_COMMENT_LINES }],
	},
	createOnce(context) {
		return {
			Program() {
				const maxLines = commentLineCap(context.options?.[0]);
				for (const block of commentBlocks(context.sourceCode.getAllComments())) {
					if (block.proseLines.length <= maxLines) continue;
					context.report({
						loc: { line: block.startLine, column: block.startColumn },
						messageId: "commentEssay",
						data: { lines: block.proseLines.length, max: maxLines },
					});
				}
			},
		};
	},
});
