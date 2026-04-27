# Task 5 — Basic View Analytics

**Basic view analytics**: Simple per-video view counts. We should keep this extremely simple. The obvious solution is to simply have a table which records requests to `/:slug*` Along with any other information we think's important. My concern with this is that there's a risk that we'll fill the database up extremely quickly. also doing this is not going to play very well with any kind of caching layer that we introduce, which serves cached resources before requests hit our Hono app. So I guess one other option that we potentially have here is to simply include something like simpleanalytics (which I already use for https://danny.is and a few other subdomains) in the HTML we send down. My only real interest here is in at least having the data available to see whether anyone has watched a given video, and if so how many (and maybe when). Oh I do not want us to build a big complex tracking system here at all and I don't really care that much at this stage about knowing whether people watch the entire video or whatever. Maybe that's something we'll want in the future but but probably not for now. So I say again, we should keep this simple.

## Phases

### Phase 1 — Research & Design
Evaluate the options (server-side request logging vs. client-side analytics like Simple Analytics vs. something else). Consider database growth, caching compatibility, and what "simple" actually looks like here. Document a recommendation.
