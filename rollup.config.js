// One self-contained bundle per entry point. The heartbeat daemon in particular
// is started as its own process, so it must not depend on shared chunks.
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

const entries = ['main', 'post', 'release', 'heartbeat']

export default entries.map((name) => ({
  input: `src/entry/${name}.ts`,
  output: {
    file: `dist/${name}.js`,
    format: 'es',
    sourcemap: false,
    inlineDynamicImports: true
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.build.json' }),
    nodeResolve({ preferBuiltins: true }),
    commonjs()
  ],
  onwarn(warning, warn) {
    // @actions/core and its dependencies have internal circular imports and
    // TypeScript-emitted top-level `this`; both are harmless.
    if (
      warning.code === 'CIRCULAR_DEPENDENCY' &&
      (warning.ids ?? []).every((id) => id.includes('node_modules'))
    ) {
      return
    }
    if (
      warning.code === 'THIS_IS_UNDEFINED' &&
      (warning.id ?? '').includes('node_modules')
    ) {
      return
    }
    warn(warning)
  }
}))
