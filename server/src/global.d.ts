// Augment Hono JSX so every HTML element accepts hx-* attributes with
// type checking. Written inline rather than referencing typed-htmx because
// typed-htmx's global `namespace JSX` declaration conflicts with Hono's
// module-scoped JSX namespace. typed-htmx is still installed as a dev dep
// for reference.
//
// This file must be a module (hence the empty export) for the `declare module`
// augmentation to merge rather than replace Hono's own declarations.
export {};

type HxSwapValue =
  | "innerHTML"
  | "outerHTML"
  | "beforebegin"
  | "afterbegin"
  | "beforeend"
  | "afterend"
  | "delete"
  | "none";

declare module "hono/jsx" {
  namespace JSX {
    interface HTMLAttributes {
      // Core request attributes
      "hx-get"?: string;
      "hx-post"?: string;
      "hx-put"?: string;
      "hx-patch"?: string;
      "hx-delete"?: string;
      // Targeting & swapping
      "hx-target"?: string;
      "hx-swap"?: HxSwapValue | (string & {});
      "hx-select"?: string;
      "hx-select-oob"?: string;
      "hx-swap-oob"?: string;
      // Triggering
      "hx-trigger"?: string;
      // Navigation
      "hx-boost"?: "true" | "false";
      "hx-push-url"?: string;
      "hx-replace-url"?: string;
      // Data
      "hx-vals"?: string;
      "hx-include"?: string;
      "hx-params"?: string;
      "hx-encoding"?: "multipart/form-data";
      // Indicators & confirmation
      "hx-indicator"?: string;
      "hx-confirm"?: string;
      "hx-disabled-elt"?: string;
      // Extensions & misc
      "hx-ext"?: string;
      "hx-preserve"?: "true";
      "hx-on"?: string;
      // Common hx-on:* event handlers
      "hx-on:htmx:xhr:progress"?: string;
      "hx-on:htmx:after-swap"?: string;
      "hx-on:htmx:after-settle"?: string;
    }
  }
}
