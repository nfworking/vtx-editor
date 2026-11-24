#!/bin/sh
# Builds vantrex-glass.node (arm64 macOS). N-API is ABI-stable, so the Node headers do not need to match Electron's.
set -e
cd "$(dirname "$0")"
NODE_INCLUDE="${NODE_INCLUDE:-$(dirname "$(dirname "$(command -v node)")")/include/node}"
xcrun clang++ -std=c++17 -fobjc-arc -arch arm64 -mmacosx-version-min=12.0 -bundle -undefined dynamic_lookup \
  -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=vantrex_glass -I"$NODE_INCLUDE" \
  -framework AppKit -framework Metal glass.mm -o vantrex-glass.node
codesign --force --sign - vantrex-glass.node
echo "built vantrex-glass.node"
