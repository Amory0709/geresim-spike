// Shader source loader.
//
// Since this project uses raw `<script type="module">` (no bundler), we can't
// use Vite/Webpack-style `?raw` imports. Instead we fetch the shader files at
// runtime. The dev server (static_server.mjs) serves them like any other
// file.
//
// We keep the .glsl files readable as standalone GLSL with `#include` lines;
// this loader resolves those includes into the embedded source so the
// WebGL2 driver only sees one big shader string.

const SHADER_PATHS = {
  'clearview-vertex.glsl':       './src/shaders/clearview-vertex.glsl',
  'clearview-fragment.glsl':     './src/shaders/clearview-fragment.glsl',
  'ppll-clear.glsl':             './src/shaders/ppll-clear.glsl',
  'ppll-resolve.glsl':           './src/shaders/ppll-resolve.glsl',
  'ppll-header.glsl':            './src/shaders/ppll-header.glsl',
  'ppll-gather.glsl':            './src/shaders/ppll-gather.glsl',
  'antialiasing.glsl':           './src/shaders/antialiasing.glsl',
  'point-to-line-distance.glsl': './src/shaders/point-to-line-distance.glsl',
  'ray-intersection.glsl':       './src/shaders/ray-intersection.glsl',
  'clearview-helpers.glsl':      './src/shaders/clearview-helpers.glsl',
};

let cache = null;

/**
 * Load all shader sources, resolve #include directives, and return a map of
 * { name: resolvedSourceString } for the 4 top-level shaders.
 */
export async function loadShaders() {
  if (cache) return cache;

  // Fetch all shader files in parallel.
  const entries = await Promise.all(
    Object.entries(SHADER_PATHS).map(async ([name, path]) => {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`Failed to load shader ${path}: ${res.status}`);
      const text = await res.text();
      return [name, text];
    })
  );

  const sources = Object.fromEntries(entries);

  function resolve(src, depth = 0) {
    if (depth > 10) throw new Error('Include depth exceeded (recursive include?)');
    const lines = src.split('\n');
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^\s*#include\s+"([^"]+)"\s*$/);
      if (m) {
        const name = m[1];
        if (!(name in sources)) {
          throw new Error(`Unknown shader include: ${name}`);
        }
        // Recursively resolve nested includes.
        lines[i] = resolve(sources[name], depth + 1);
        changed = true;
      }
    }
    return changed ? lines.join('\n') : src;
  }

  cache = {
    clearviewVertex:   resolve(sources['clearview-vertex.glsl']),
    clearviewFragment: resolve(sources['clearview-fragment.glsl']),
    ppllClear:         resolve(sources['ppll-clear.glsl']),
    ppllResolve:       resolve(sources['ppll-resolve.glsl']),
  };

  return cache;
}