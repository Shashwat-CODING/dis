const express = require("express");
const { google } = require("googleapis");
const cors = require("cors");
const session = require("express-session");
const ytdl = require("@distube/ytdl-core");

const app = express();
const PORT = 3100;

// OAuth Credentials
const CLIENT_ID = "1023316916513-0ceeamcb82h4c5j27p7pnrbq0fl9udhd.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:3100/oauth2callback"; // Change this when deploying

// Configure OAuth2 client
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// YouTube API client
const youtube = google.youtube({
  version: "v3",
  auth: oauth2Client
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(
  session({
    secret: "youtube_api_session_secret",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
  })
);

// Ensure tokens are refreshed before making API calls
async function ensureAuthenticated(req) {
  if (!req.session.tokens) {
    throw new Error("Not authenticated");
  }

  oauth2Client.setCredentials(req.session.tokens);

  // Refresh the token if it's expired
  if (oauth2Client.isTokenExpiring()) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    req.session.tokens = credentials;
    oauth2Client.setCredentials(credentials);
  }
}

// Get audio stream URL (Uses OAuth properly)
app.get("/streams/:videoId", async (req, res) => {
  const { videoId } = req.params;

  try {
    await ensureAuthenticated(req); // Ensure OAuth token is valid

    // Get video details
    const videoResponse = await youtube.videos.list({
      part: "snippet",
      id: videoId
    });

    if (!videoResponse.data.items.length) {
      return res.status(404).json({ error: "Video not found" });
    }

    const videoDetails = videoResponse.data.items[0];
    const title = videoDetails.snippet.title;

    // Fetch audio stream using ytdl-core
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`, {
      requestOptions: {
        headers: {
          "Authorization": `Bearer ${req.session.tokens.access_token}`
        }
      }
    });

    const audioFormats = ytdl.filterFormats(info.formats, "audioonly");

    if (audioFormats.length > 0) {
      return res.json({
        audioUrl: audioFormats[0].url,
        title: title
      });
    } else {
      return res.status(404).json({ error: "No audio streams found" });
    }

  } catch (error) {
    console.error("Error fetching video:", error);

    if (error.message.includes("Not authenticated")) {
      return res.status(401).json({ error: "Not authenticated, login required" });
    }

    if (error.message.includes("quota")) {
      return res.status(429).json({ error: "YouTube API quota exceeded" });
    }

    return res.status(500).json({ error: "Failed to fetch audio" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
