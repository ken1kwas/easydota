/**
 * Plugin SDK for Dota 2 Minify plugins.
 *
 *   const router = new PluginRouter();
 *   router.route("play_sound", (params) => ({ status: "playing", path: params.path }));
 *   export const handleApi = (action: string, params?: Params) => router.dispatch(action, params);
 */

export type Params = Record<string, any>;
export type Handler = (params: Params) => unknown | Promise<unknown>;

export class PluginRouter {
  private readonly routes = new Map<string, Handler>();

  /** Registers a handler. With a named function the name can be omitted: `router.route(getMods)`. */
  route(nameOrHandler: string | Handler, handler?: Handler): this {
    if (typeof nameOrHandler === "function") {
      this.routes.set(nameOrHandler.name, nameOrHandler);
    } else if (handler) {
      this.routes.set(nameOrHandler, handler);
    }
    return this;
  }

  async dispatch(action: string, params?: Params | null): Promise<unknown> {
    const handler = this.routes.get(action);
    if (!handler) return { error: `Unknown action '${action}'` };
    return handler(params ?? {});
  }

  getRegisteredActions(): string[] {
    return [...this.routes.keys()];
  }
}
