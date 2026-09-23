#!/bin/bash
# Parse and render a Mermaid file. Non-zero exit means invalid syntax.
# Usage: validate.sh diagram.mmd [output.svg]

set -euo pipefail

if [ $# -lt 1 ]; then
	echo "Usage: $0 diagram.mmd [output.svg]" >&2
	exit 1
fi

INPUT="$1"
OUTPUT="${2:-}"
CLEANUP=0

if [ ! -f "$INPUT" ]; then
	echo "Error: file not found: $INPUT" >&2
	exit 1
fi

if [ -z "$OUTPUT" ]; then
	OUTPUT=$(mktemp -t mermaid_validate.XXXXXX).svg
	CLEANUP=1
fi

cleanup() {
	if [ "$CLEANUP" -eq 1 ]; then rm -f "$OUTPUT"; fi
}
trap cleanup EXIT

echo "Validating: $INPUT"

if ! npx -y @mermaid-js/mermaid-cli -i "$INPUT" -o "$OUTPUT" -q; then
	echo "✗ Mermaid validation failed" >&2
	exit 1
fi

echo "✓ Mermaid OK"
[ "$CLEANUP" -eq 0 ] && echo "Rendered to: $OUTPUT"

echo
echo "ASCII preview:"
if ! MERMAID_INPUT="$INPUT" npx -y --package beautiful-mermaid node -e '
const fs = require("node:fs");
const path = require("node:path");
const moduleRoot = path.dirname(process.env.PATH.split(":")[0]);
const { renderMermaidAscii } = require(path.join(moduleRoot, "beautiful-mermaid"));
process.stdout.write(renderMermaidAscii(fs.readFileSync(process.env.MERMAID_INPUT, "utf8")) + "\n");
'; then
	echo "(preview unavailable for this diagram type)"
fi
