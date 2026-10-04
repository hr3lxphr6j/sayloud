#!/bin/bash
# Download HeadTTS English dictionary
# Source: https://github.com/met4citizen/HeadTTS (MIT License)

set -e

DICT_DIR="public/dictionaries"
DICT_FILE="$DICT_DIR/headtts-en-us.txt"
DICT_URL="https://raw.githubusercontent.com/met4citizen/HeadTTS/main/dictionaries/en-us.txt"
EXPECTED_SHA256="to_be_calculated"

mkdir -p "$DICT_DIR"

echo "Downloading HeadTTS English dictionary..."
curl -L "$DICT_URL" -o "$DICT_FILE"

echo "Dictionary downloaded to $DICT_FILE"
echo "Size: $(wc -c < "$DICT_FILE") bytes"
echo "Lines: $(wc -l < "$DICT_FILE")"

# Calculate SHA256 for verification
ACTUAL_SHA256=$(shasum -a 256 "$DICT_FILE" | awk '{print $1}')
echo "SHA256: $ACTUAL_SHA256"

echo "✓ HeadTTS dictionary setup complete"
