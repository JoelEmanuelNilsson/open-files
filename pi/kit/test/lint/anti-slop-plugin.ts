import { eslintCompatPlugin } from "@oxlint/plugins";

import { noWidenThenAssertRule } from "../../skills/install-anti-slop/assets/anti-slop/rules/no-widen-then-assert.ts";
import { requireSafetyCommentForTypeAssertionRule } from "../../skills/install-anti-slop/assets/anti-slop/rules/require-safety-comment-for-type-assertion.ts";

/** The anti-slop rules this kit enforces on its own source. */
export default eslintCompatPlugin({
	meta: { name: "anti-slop" },
	rules: {
		"no-widen-then-assert": noWidenThenAssertRule,
		"require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertionRule,
	},
});
