# Task: Proper Server API

Goal: Turn the prorotype Hono app into a proper backend server API which accepts videos from the macOS app and can be deployed to Hertzner. We are not trying to be feature complete here, just have a good, well set up, secure system, which can be run locally and deployed. 

## Developer Tooling and Cleanup

Let's get the hono server properly set up with development tools for linting, formatting, checking, testing etc. We can also take this opportunity to do a little bit of clean up and refactoring and re architecture to get us ready for what we know we're gonna be doing. 

## Test Setup & Tests

Let's get an automated testing framework set up in here and add tests for anything which we already have, which we should definitely have unit tests or any other types of tests for. 

## SQLite + Drizzle ORM and Data Models etc

Okay, up to now we have just been using files on the server to manage recordings and everything. We should now transition to a proper data model using SQLite and Drizzle ORM. This may also be an opportunity for us to potentially look at some validation both in the API layer and the data layer. And also potentially look at some sensible refactorings or abstractions to make this stuff easier to work with in the code base. 

## Styling System

We need to decide on our approach to templating and CSS and set up a suitable structure for templating and serving HTML pages, as well as a sensible CSS reset/base/global CSS vars etc. Although at the moment the only HTML we need to style is the user-facing video page, we will eventually have an Admin side to this Hono app too, which will need a proper system of reusable components and the like. Let's at least get ready for that and make our life easier.

## Auth for menubar app

We need to set up a Auth system for the API endpoints and change the macOs menubar app so it sends authenticated requests. I'd suggest that a simple API key and Bearer tokens is probably the best way to go here, considering it's only me who's gonna be using this. But we obviously want to consider security best practice here as well. 

## Add all expected endpoints

This is the point to map out all of our current API endpoints and also think about the other API endpoints we know we are going to need going forward. This should include:

- API endpoints for use by the macOS app (all of which will be authenticated eventually)
- User-facing "Web" endpoints (see below)
- A web endpoint for the admin panel (eventually will be authed via web login)

Where we have the data and information to populate and actually do these endpoints, we can do them now (if they're simple). where we don't, we should just create stub endpoints, which we will then build out later. The admin pages is a good example of this.

## Improve viewer-facing video page

NOTE: We may eventually replicate these endpoints using CloudFlare Workers, but In the spirit of iterative development, I would like to start by serving them from our Honno app.

### `/:slug`

The HTML page which renders the video player

- Serve a performant & accessible HTML page with the correct SEO, metadata, OG tags/images etc.
- Suitably render the title and other video metadata, and a little link to my website etc.
- Minimal but on-brand CSS styling
- Player is as good and properly configured as it can be

### `/:slug/embed`

Serves the HTML Video player with no padding or other chrome. Intended for use in iframes.

### `/:slug.mp4`

Serves the `source.mp4` directly with appropriate headers.

### `/:slug.json`

Serves a JSON representation of the video data including the URLs above. Intended for programmatic and LLM consumption.

### `/:slug.md`

Serves a Markdown representation of the video data including the URLs above. This will be a very sparse markdown file for videos which do not have a title, description, transcription etc. But that's fine. We're including it here so that further down the line when we are generating titles, descriptions, transcriptions, this endpoint & template is already here. 

## Full Review of Serverside App

And finally, let's conduct a full comprehensive review of all of the server side code. Let's clean up anything that needs cleaning, do any re-architecting, analyze and review it for code quality, architectural quality, and best practices, as well as any obvious issues with performance etc.
