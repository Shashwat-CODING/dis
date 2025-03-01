const express = require("express");
const ytdl = require("@distube/ytdl-core");
const cors = require("cors");

const app = express();
const PORT = 3100;

app.use(cors());

app.get("/streams/:videoId", async (req, res) => {
    const videoId = req.params.videoId;

    if (!videoId) {
        return res.status(400).json({ error: "Missing video ID" });
    }

    try {
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const info = await ytdl.getInfo(url);
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
