/**
 * The injection token for the one `Bridge` (the store, the four service
 * ports, and settings) every controller and background loop works through.
 * Production provides it from the environment; a test provides a fake.
 */
export const BRIDGE = Symbol('BRIDGE')
