#!/bin/sh

apt-get update && apt-get install -y wget unzip
wget -qO- https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb > /tmp/chrome.deb
dpkg -i /tmp/chrome.deb || apt-get -f install -y
rm /tmp/chrome.deb
