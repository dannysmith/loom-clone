import { siteConfig } from "../../lib/site-config";
import { staticUrl } from "../../lib/static-assets";

// Shared footer for public viewer pages (video, tag).
// Avatar + author name + tagline + social links. All values flow from
// siteConfig — edit there to update everything at once.
export function SiteFooter() {
  return (
    <footer class="site-footer">
      <img
        class="site-footer-avatar"
        src={staticUrl(siteConfig.authorAvatar.replace(/^\/static\//, ""))}
        alt={siteConfig.authorName}
        width={72}
        height={72}
      />
      <p class="site-footer-name">{siteConfig.authorName}</p>
      <p class="site-footer-tagline">{siteConfig.tagline}</p>
      <ul class="site-footer-socials">
        {siteConfig.socials.map((s) => (
          <li>
            <a href={s.url} rel="me noopener" target="_blank">
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </footer>
  );
}
