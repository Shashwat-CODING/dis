const ytdl = require('@distube/ytdl-core');

async function getAudioStream(videoId) {
    if (!ytdl.validateID(videoId)) {
        throw new Error('Invalid Video ID');
    }

    const info = await ytdl.getInfo(videoId);
    const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });

    if (!format || !format.url) {
        throw new Error('Failed to fetch audio');
    }

    return format.url;
}

module.exports = { getAudioStream };
