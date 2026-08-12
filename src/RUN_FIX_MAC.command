#!/bin/bash
cd "$(dirname "$0")"
echo "Applying LINE Card v7.6 fix..."
node apply-line-card-review-fix.mjs
echo
echo "Done. Press Enter to close."
read
