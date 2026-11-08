three.js r187 (MIT, see LICENSE) - only the classes board/dice3d.js uses, bundled + minified:
  npm pack three@0.187.0; esbuild entry.js --bundle --minify --format=esm (entry re-exports the names imported in dice3d.js)
