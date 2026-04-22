# Task: Admin Panel Improvements

We have just completed `task-3-admin-panel.md` And now we have a little more work to do on it to improve it.

## UI Improvements

- Icons - We don't currently use icons anywhere in the UI. Let's introduce some SVG icons and use them in:
  - Sidebar: Icon for dashboard, settings and trash. This will also allow us to remove the words from the sidebar and make the sidebar just thin enough for those icons. So it's you know just a thin thing on the side. We can also use those icons if we want to on some of the individual pages if we think that looks right. 
  - Replace "Grid" and "Table" toggle words with icons
  - Add upload icon to "Upload" button on dashboard.
  - Add icons for video actions (Open public URL, Download, Duplicate) etc
  - Decide on suitable icsond for "unlisted" "public" and "private" and use them in the pills for those
- Make the "unlisted" "public" and "private" pills different colours. publicly listed videos should probably be a fairly bright blue. Unlisted videos can stay great. And private videos could maybe be some sort of light red or something. The point of this is to make them stand out. 
- But we should also make the status pills have colours too suitable to their statuses. again, so that they stand out. "Completed" ones can stay grey.
- when I first click on a video in the dashboard it opens up the video page but the player doesn't show immediately. I have to refresh the page to get the actual player to show up. Let's fix that. 
- Some of the buttons. For example, the buttons for the actions in the video view page have underlines in them. That's because they're links. And some of them don't. We should make sure that they all look and work consistently. 
- when on the dashboard clicking the "..." Does correctly show the actions pop over, but it always appears in the very top left of the screen. we could use the new CSS anchor position to make this work a little bit better. Worth looking online to find out what modern CSS can do here. There's been some significant changes recently around how pop overs work and also anchor positioning. 
- We have a number of different dropdowns which we are using in the app in various places, both for filtering and sorting and for things like changing the status. These currently just use standard browser select elements Which means that the interface isn't particularly nice inside of them. There are some newer CSS features which have come out very recently that allow us to properly style the insides of select elements, including things like icons and so on and so forth, we should make use of that if we can. And we should also make sure that the select elements are themselves styled to look fairly nice. 
- We should give a little bit of love to how we render some of the video meta information. Things like created at date and duration and stuff. I think we can probably make these look a little bit nicer. We could maybe have some kind of cool little I don't know component that renders the duration in a little kind of film card or something to make that look a bit nicer. That would also allow us to use that on the cards and on the video page, and we wouldn't need the labels on the video page. 
- we should have a consistent tag picker which ideally would look like a normal input and allow us to add tags kinda easily and then click across to remove them. I don't really know what the best way of doing this is, but it should be consistent everywhere we allow people to add remove or show tags, but obviously if we're just showing them we should use the same component but they wouldn't be editable. 
