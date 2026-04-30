import { raw } from "hono/html";
import type { Child, PropsWithChildren } from "hono/jsx";
import { staticUrl } from "../../lib/static-assets";

type Props = PropsWithChildren<{
  title: string;
  // Optional extra <head> nodes for page-specific stylesheets, OG tags, etc.
  head?: Child;
  // Class name on <body>, lets layouts theme themselves without separate <html> trees.
  bodyClass?: string;
}>;

export function RootLayout({ title, head, bodyClass, children }: Props) {
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>{title}</title>
          <link rel="stylesheet" href={staticUrl("styles/app.css")} />
          {head}
        </head>
        <body class={bodyClass}>{children}</body>
      </html>
    </>
  );
}
