import { plugin } from 'bun'

// Vite compiles `*.module.scss` into a class-name map; Bun's runtime has no CSS
// module loader and falls back to the `file` loader, so the same import lands in
// tests as a plain string — the stylesheet's path. Every `styles.foo` then reads
// a property off a String, which is `undefined` for most names but resolves to a
// real function for the legacy String.prototype members: `link`, `big`, `bold`,
// `small`, `sub`, `sup`, `fixed`, `italics`, `strike`, `blink`, `anchor`,
// `fontcolor`, `fontsize`, `concat`, `trim`, `at`. React rejects a function
// className outright ("Invalid value for prop `className`"), and warns only once
// per prop name for the whole run, so a single collision masks all the others.
//
// Hand tests an identity map instead, matching the `Record<string, string>` that
// src/vite-env.d.ts already declares: `styles.link` is the string "link".
const classNames: Record<string, string> = new Proxy(Object.create(null), {
  get: (_target, key) => (typeof key === 'string' ? key : undefined),
})

plugin({
  name: 'scss-modules',
  setup: (build) => {
    build.onLoad({ filter: /\.s?css$/ }, () => ({
      exports: { default: classNames },
      loader: 'object',
    }))
  },
})
