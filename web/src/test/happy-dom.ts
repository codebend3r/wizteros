import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Bun test has no DOM by default. Register happy-dom's globals (window,
// document, etc.) before any test module, or Testing Library, evaluates.
GlobalRegistrator.register()
