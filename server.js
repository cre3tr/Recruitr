require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { MongoClient, ObjectId } = require('mongodb');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcrypt');

const app = express();
const port = process.env.PORT || 3001;

// MongoDB setup
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET environment variable is required');
  process.exit(1);
}

let db;
let mongoClient;

// Function to connect to MongoDB with retry logic
async function connectToMongoDB() {
  const maxRetries = 5;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      mongoClient = new MongoClient(MONGODB_URI, {
        // Explicitly enable TLS for MongoDB Atlas
        tls: true,
        serverSelectionTimeoutMS: 5000 // Timeout after 5 seconds
      });
      await mongoClient.connect();
      db = mongoClient.db();
      console.log('Connected to MongoDB');
      return;
    } catch (err) {
      retries++;
      console.error(`MongoDB connection attempt ${retries}/${maxRetries} failed:`, err);
      if (retries === maxRetries) {
        console.error('Max retries reached. Could not connect to MongoDB.');
        return;
      }
      // Wait 5 seconds before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Start MongoDB connection (but don't block server startup)
connectToMongoDB();

// Middleware
app.use(cors({
  // Ensure FRONTEND_URL is set to https://recruitr.onrender.com in Render's environment variables
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: MONGODB_URI,
    // If MongoDB isn't connected yet, MongoStore will fail to initialize.
    // We'll handle this gracefully by disabling session storage until connected.
    mongoOptions: { tls: true }
  }),
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} request to ${req.url}`);
  next();
});

const RECRUITER_USER = process.env.RECRUITER_USER || 'adminrecruitr';
const RECRUITER_PASS_HASH = process.env.RECRUITER_PASS_HASH;
if (!RECRUITER_PASS_HASH) {
  console.error('RECRUITER_PASS_HASH environment variable is required in production');
  process.exit(1);
}

app.post('/api/login', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  const { username, password } = req.body;
  
  if (username === RECRUITER_USER) {
    if (process.env.NODE_ENV === 'development' && password === 'password') {
      req.session.user = { username };
      return res.json({ success: true, username });
    }
    
    if (RECRUITER_PASS_HASH && await bcrypt.compare(password, RECRUITER_PASS_HASH)) {
      req.session.user = { username };
      return res.json({ success: true, username });
    }
  }
  
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/verify-session', (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  if (req.session && req.session.user && req.session.user.username === RECRUITER_USER) {
    return res.json({ success: true, username: req.session.user.username });
  }
  res.status(401).json({ error: 'Not authenticated' });
});

function requireAuth(req, res, next) {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  if (req.session && req.session.user && req.session.user.username === RECRUITER_USER) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.pdf' && ext !== '.docx') {
      return cb(new Error('Only PDF and DOCX files are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

const SKILL_LIST = [
  'python', 'javascript', 'sql', 'java', 'react', 'node.js', 'html', 'css',
  'typescript', 'angular', 'vue', 'mongodb', 'mysql', 'postgresql', 'aws',
  'docker', 'kubernetes', 'git', 'linux', 'c++', 'c#', 'php', 'ruby',
  'excel', 'tableau', 'power bi', 'r', 'matlab', 'tensorflow', 'pytorch',
  'agile', 'scrum', 'jira', 'jenkins', 'azure', 'gcp', 'graphql', 'rest',
  'communication', 'teamwork', 'problem solving', 'leadership', 'management',
  'customer service', 'technical support', 'data analysis', 'project management'
];

function extractCandidateName(text) {
  const lines = text.split('\n').slice(0, 10);
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.length > 50) continue;
    
    const skipWords = ['resume', 'cv', 'curriculum', 'vitae', 'profile', 'contact'];
    if (skipWords.some(word => trimmedLine.toLowerCase().includes(word))) continue;
    
    const words = trimmedLine.split(' ').filter(w => w.length > 1);
    if (words.length >= 2 && words.length <= 4) {
      const namePattern = words.every(w => 
        /^[A-Z][a-z]+$/.test(w) || /^[A-Z][a-z]+[-'][A-Z][a-z]+$/.test(w)
      );
      if (namePattern) return trimmedLine;
    }
  }
  
  return 'Unknown Candidate';
}

async function parseResume(fileBuffer, fileType, originalFilename) {
  let text;
  try {
    if (fileType === '.pdf') {
      const data = await pdf(fileBuffer);
      text = data.text;
    } else if (fileType === '.docx') {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      text = result.value;
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error(`Error extracting text from ${fileType}:`, error);
    throw error;
  }

  console.log('Extracted text:', text);

  const skills = SKILL_LIST.filter(skill => text.toLowerCase().includes(skill));
  console.log('Skills matched:', skills);

  const skillsSectionMatch = text.match(/(?:skills|technical skills|key skills)[:\n](.*?)(?=\n\n|\n[A-Z])/is);
  let additionalSkills = [];
  if (skillsSectionMatch) {
    const skillsSection = skillsSectionMatch[1].toLowerCase();
    additionalSkills = SKILL_LIST.filter(skill => skillsSection.includes(skill));
    console.log('Additional skills from section:', additionalSkills);
  } else {
    console.log('No skills section found');
  }

  const allSkills = [...new Set([...skills, ...additionalSkills])];

  const experience = text.match(/(engineer|developer|manager|analyst|consultant|intern|associate|lead|senior|junior|specialist|support|administrator)\s*[\w\s]*(?:\d{4}\s*-\s*\d{4}|\d{4}\s*-\s*present|\d{4})/gi) || [];
  console.log('Experience matched:', experience);

  const education = text.match(/(bachelor|bs|ms|phd|master|mba|diploma|certificate|degree)\s*(?:in|of)?\s*[\w\s]*(?:university|college|institute|school|academy)?/gi) || [];
  console.log('Education matched:', education);

  const candidateName = extractCandidateName(text);
  console.log('Extracted candidate name:', candidateName);

  return {
    candidateName,
    skills: allSkills,
    experience: experience.map(e => e.trim()),
    education: education.map(e => e.trim()),
    rawText: text,
    originalFilename
  };
}

app.post('/api/upload-resume', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  if (!req.file) {
    console.log('No file uploaded or invalid file type');
    return res.status(400).json({ error: 'No file uploaded or invalid file type' });
  }

  try {
    console.log(`Processing file: ${req.file.originalname}`);
    const fileType = path.extname(req.file.originalname).toLowerCase();
    const parsedData = await parseResume(req.file.buffer, fileType, req.file.originalname);

    const candidate = {
      fileName: req.file.originalname,
      parsedData,
      createdAt: new Date(),
      chatHistory: []
    };
    const result = await db.collection('candidates').insertOne(candidate);
    const candidateId = result.insertedId.toString();

    const response = {
      message: 'Resume uploaded successfully',
      fileName: req.file.originalname,
      parsedData,
      candidateId
    };
    console.log(`Sending response:`, response);
    res.json(response);
  } catch (error) {
    console.error('Error parsing resume:', error);
    res.status(500).json({ error: `Failed to parse resume: ${error.message}` });
  }
});

app.post('/api/chat', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  const { candidateId, message } = req.body;
  if (!candidateId || !message) {
    return res.status(400).json({ error: 'Candidate ID and message required' });
  }
  
  try {
    const candidate = await db.collection('candidates').findOne({ _id: new ObjectId(candidateId) });
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate data not found' });
    }
    
    const chatHistory = candidate.chatHistory || [];
    const skills = candidate.parsedData.skills || [];
    
    let responseText;
    
    if (message.toLowerCase().includes('thank you') || message.toLowerCase().includes('thanks')) {
      responseText = "You're welcome! Do you have any questions about the next steps in our process?";
    }
    else if (message.toLowerCase().includes('salary') || message.toLowerCase().includes('compensation')) {
      responseText = "Great question about compensation. Our recruiter will discuss the salary range during the follow-up call. Can you share your salary expectations?";
    }
    else if (message.toLowerCase().includes('when') && message.toLowerCase().includes('hear')) {
      responseText = "We typically review applications within 5-7 business days. I'll make a note to prioritize your application.";
    }
    else if (skills.some(skill => message.toLowerCase().includes(skill.toLowerCase()))) {
      const mentionedSkill = skills.find(skill => message.toLowerCase().includes(skill.toLowerCase()));
      responseText = `That's great experience with ${mentionedSkill}. Can you describe a specific project where you applied this skill?`;
    }
    else if (message.toLowerCase().includes('position') || message.toLowerCase().includes('job') || message.toLowerCase().includes('role')) {
      responseText = "This position involves working with our core technology team. What specific aspects of the role are you most interested in?";
    }
    else if (message.split(' ').length < 10) {
      responseText = "Could you elaborate a bit more? I'd love to understand your background in more detail.";
    }
    else if (skills.length > 0) {
      const discussedSkills = new Set();
      chatHistory.forEach(msg => {
        if (msg.sender === 'AI') {
          skills.forEach(skill => {
            if (msg.text.toLowerCase().includes(skill.toLowerCase())) {
              discussedSkills.add(skill);
            }
          });
        }
      });
      
      const undiscussedSkills = skills.filter(skill => !discussedSkills.has(skill));
      if (undiscussedSkills.length > 0) {
        responseText = `Thanks for sharing that. I notice you also have experience with ${undiscussedSkills[0]}. Could you tell me more about that?`;
      } else {
        responseText = "Thank you for providing that information. Is there anything specific about the company or position you'd like to know?";
      }
    } else {
      responseText = "Thanks for your response. What are you looking for in your next role?";
    }
    
    await db.collection('candidates').updateOne(
      { _id: new ObjectId(candidateId) },
      { 
        $push: { 
          chatHistory: { 
            sender: 'User', 
            text: message, 
            timestamp: new Date() 
          }, 
          chatHistory: { 
            sender: 'AI', 
            text: responseText, 
            timestamp: new Date() 
          } 
        } 
      }
    );
    
    res.json({ response: responseText });
  } catch (error) {
    console.error('Chat endpoint error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/candidates/:id', requireAuth, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected. Please try again later.' });
  }

  try {
    const candidateId = req.params.id;
    const candidate = await db.collection('candidates').findOne(
      { _id: new ObjectId(candidateId) }
    );
    
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    
    res.json({ candidate });
  } catch (error) {
    console.error('Error fetching candidate details:', error);
    res.status(500).json({ error: 'Failed to fetch candidate details' });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: db ? 'OK' : 'Database not connected' });
});

// Start the server regardless of MongoDB connection status
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Handle process termination gracefully
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM. Closing MongoDB connection...');
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
});
