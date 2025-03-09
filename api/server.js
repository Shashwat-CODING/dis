const express = require("express");
const { google } = require("googleapis");
const cors = require("cors");
const session = require("express-session");
const ytdl = require("@distube/ytdl-core");

const app = express();
const PORT = 3100;

// OAuth Credentials (Keep these secure)
const CLIENT_ID = "1023316916513-0ceeamcb82h4c5j27p7pnrbq0fl9udhd.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:3100/oauth2callback"; // Change this when deploying to Render

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

// Generate authentication URL
app.get("/auth", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/youtube.readonly"]
  });
  res.redirect(authUrl);
});

// OAuth callback handler
app.get("/oauth2callback", async (req, res) => {
  const { code } = req.query;
  
  try {
    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // Store tokens in session
    req.session.tokens = tokens;
    
    res.redirect("/auth-success");
  } catch (error) {
    console.error("OAuth error:", error);
    res.status(500).send("Authentication failed");
  }
});

// Auth success page
app.get("/auth-success", (req, res) => {
  res.send("Authentication successful! You can now use the API.");
});

// Get audio stream URL
app.get("/streams/:videoId", async (req, res) => {
  const { videoId } = req.params;
  
  if (!req.session.tokens) {
    return res.status(401).json({ 
      error: "Not authenticated", 
      authUrl: "/auth" 
    });
  }
  
  try {
    oauth2Client.setCredentials(req.session.tokens);
    
    // Get video details
    const videoResponse = await youtube.videos.list({
      part: "snippet,contentDetails",
      id: videoId
    });
    
    if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
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
    
    if (error.message.includes("invalid_grant") || error.message.includes("token expired")) {
      if (req.session.tokens.refresh_token) {
        try {
          const { tokens } = await oauth2Client.refreshToken(req.session.tokens.refresh_token);
          req.session.tokens = tokens;
          return res.status(401).json({ error: "Token refreshed, please try again" });
        } catch (refreshError) {
          return res.status(401).json({ error: "Authentication expired", authUrl: "/auth" });
        }
      } else {
        return res.status(401).json({ error: "Authentication expired", authUrl: "/auth" });
      }
    }
    
    return res.status(500).json({ error: "Failed to fetch audio" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT}/auth to authenticate`);
});
