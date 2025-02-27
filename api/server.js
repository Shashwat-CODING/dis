const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');

const app = express();
const PORT = process.env.PORT || 3100;

app.use(cors());

app.get('/stream/:videoId', async (req, res) => {
    const videoId = req.params.videoId;

    if (!ytdl.validateID(videoId)) {
        return res.status(400).json({ error: 'Invalid Video ID' });
    }

    try {
        const info = await ytdl.getInfo(videoId);
        const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });

        if (!format || !format.url) {
            return res.status(500).json({ error: 'Failed to fetch audio' });
        }

        res.json({ audioUrl: format.url });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Failed to fetch audio' });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
