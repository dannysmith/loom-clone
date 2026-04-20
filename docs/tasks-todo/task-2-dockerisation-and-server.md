# Task: Dockerisation & Server Setup

Our goal with this task is to actually get our server running on Hertzner in an easy to manage way. Now since I don't expect this server to be constantly under heavy load, I'd like to make sure this is all set up in a way where I can potentially run this server alongside a bunch of other things on a Hertzner VPS (eg. an n8n instance, or some other little custom services). Although we will start by only running this. Now that leads me to think that probably the work we need to do is gonna include:

- Dockerising the LoomClone server, potentially into multiplpe services with docker-compose?
- Creating a simple setup.sh to configure the new server.
  - We may find https://github.com/dannysmith/mc-infra/blob/main/setup.sh and https://github.com/dannysmith/mc-infra/blob/main/setup-ssl.sh and https://github.com/dannysmith/mc-infra/blob/main/configure-bash.sh helpful here. (See `~/dev/mc-infra/` for that repo locally)
- Spinning up a new Hertzner server and ensuring it is properly configured and setting up local DNS etc.
- Optional - Setting up a sensible deployment process so pushes to `main` in `server` are properly deployed to the Box

## Phase 1 - Dockerisation

## Phase 2 - Server Setup Tooling & Docs

## Phase 3 - Server Set Up

## Phase 4 - CI/CD Pipeline for Server

## ???
