import type { Bindings } from './env';

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}
