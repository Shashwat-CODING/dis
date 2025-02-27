const express = require("express");
const ytdl = require("@distube/ytdl-core");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const chromium = require("chromium");

const app = express();
const PORT = 3100;

app.use(cors());

// Function to get YouTube cookies using Puppeteer
async function getYouTubeCookies() {
    const browser = await puppeteer.launch({
        executablePath: chromium.path,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
    });

    const page = await browser.newPage();
    await page.goto('https://www.youtube.com');

    const cookies = await page.cookies();
    await browser.close();

    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

app.get("/streams/:videoId", async (req, res) => {
    const videoId = req.params.videoId;

    if (!videoId) {
        return res.status(400).json({ error: "Missing video ID" });
    }

    try {
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const cookies = await getYouTubeCookies();

        const info = await ytdl.getInfo(url, {
            requestOptions: { headers: { Cookie: cookies } }
        });

        const audioFormats = ytdl.filterFormats(info.formats, "audioonly");

        if (audioFormats.length > 0) {
            return res.json({
                audioUrl: audioFormats[0].url,
                title: info.videoDetails.title,
            });
        } else {
            return res.status(404).json({ error: "No audio streams found" });
        }
    } catch (error) {
        console.error("Error fetching audio:", error);
        return res.status(500).json({ error: "Failed to fetch audio" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
