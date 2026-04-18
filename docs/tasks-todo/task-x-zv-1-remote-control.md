# Task: Sony ZV-1 Remote Control

My main "webcam" is a Sony ZV-1. I currently have it connected via USB with "PC Mode" on. When I want to use it I turn it on and press Menu > USB Streaming which then uses the USB connection as a WebCam Feed. Once I change this so that it's connnected via an Elgato CamLink, the USB connection will be available for remote control. We can use `gphoto2` to control it and get info about it.

I want to investigate adding a specific module to the macOS app which is only available when the ZV-1 is connected, which lets me set the camera up well for "webcam" use and tweak various different settings. May actually make sense to build this as a completely separate app, but I figure we may as well prorotype it as part of this app, since it'll mean I don't need to have a seperate thing running.
