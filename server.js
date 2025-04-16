const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory store for parsed resume data (replace with DB later)
let candidateData = {};

// Set up file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.pdf' && ext !== '.docx') {
      return cb(new Error('Only PDF and DOCX files are allowed'));
    }
    cb(null, true);
  }
});

// Expanded skill list for matching
const SKILL_LIST = [
  'python', 'javascript', 'sql', 'java', 'react', 'node.js', 'html', 'css',
  'typescript', 'angular', 'vue', 'mongodb', 'mysql', 'postgresql', 'aws',
  'docker', 'kubernetes', 'git', 'linux', 'c++', 'c#', 'php', 'ruby',
  'excel', 'tableau', 'power bi', 'r', 'matlab', 'tensorflow', 'pytorch',
  'agile', 'scrum', 'jira', 'jenkins', 'azure', 'gcp', 'graphql', 'rest',
  'communication', 'teamwork', 'problem solving', 'leadership', 'management',
  'customer service', 'technical support', 'data analysis', 'project management'
];

// Parse resume function
async function parseResume(filePath, fileType) {
  let text;
  try {
    if (fileType === '.pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdf(dataBuffer);
      text = data.text;
    } else if (fileType === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value;
    }
  } catch (error) {
    console.error(`Error extracting text from ${fileType}:`, error);
    throw error;
  }

  console.log('Extracted text:', text);

  // Basic parsing logic
  const skills = SKILL_LIST.filter(skill => text.toLowerCase().includes(skill));
  console.log('Skills matched:', skills);

  // Fallback: Extract skills from common sections (e.g., "Skills:", "Technical Skills:")
  const skillsSectionMatch = text.match(/(?:skills|technical skills|key skills)[:\n](.*?)(?=\n\n|\n[A-Z])/is);
  let additionalSkills = [];
  if (skillsSectionMatch) {
    const skillsSection = skillsSectionMatch[1].toLowerCase();
    additionalSkills = SKILL_LIST.filter(skill => skillsSection.includes(skill));
    console.log('Additional skills from section:', additionalSkills);
  } else {
    console.log('No skills section found');
  }

  // Combine skills and remove duplicates
  const allSkills = [...new Set([...skills, ...additionalSkills])];

  // More flexible regex for experience
  const experience = text.match(/(engineer|developer|manager|analyst|consultant|intern|associate|lead|senior|junior|specialist|support|administrator)\s*[\w\s]*(?:\d{4}\s*-\s*\d{4}|\d{4}\s*-\s*present|\d{4})/gi) || [];
  console.log('Experience matched:', experience);

  // More flexible regex for education
  const education = text.match(/(bachelor|bs|ms|phd|master|mba|diploma|certificate|degree)\s*(?:in|of)?\s*[\w\s]*(?:university|college|institute|school|academy)?/gi) || [];
  console.log('Education matched:', education);

  return {
    skills: allSkills,
    experience: experience.map(e => e.trim()),
    education: education.map(e => e.trim()),
    rawText: text
  };
}

// API endpoint for resume upload
app.post('/api/upload-resume', upload.single('resume'), async (req, res) => {
  if (!req.file) {
    console.log('No file uploaded or invalid file type');
    return res.status(400).json({ error: 'No file uploaded or invalid file type' });
  }

  try {
    console.log(`Processing file: ${req.file.filename}`);
    const fileType = path.extname(req.file.filename).toLowerCase();
    const parsedData = await parseResume(req.file.path, fileType);

    // Store parsed data with candidate ID (using timestamp for simplicity)
    const candidateId = Date.now().toString();
    candidateData[candidateId] = parsedData;

    const response = {
      message: 'Resume uploaded successfully',
      fileName: req.file.filename,
      parsedData,
      candidateId
    };
    console.log(`Sending response:`, response);
    res.json(response);
  } catch (error) {
    console.error('Error parsing resume:', error);
    res.status(500).json({ error: 'Failed to parse resume' });
  }
});

// API endpoint for chat interactions
app.post('/api/chat', (req, res) => {
  const { candidateId, message } = req.body;
  if (!candidateId || !message) {
    console.log('Missing candidateId or message');
    return res.status(400).json({ error: 'Candidate ID and message required' });
  }

  const candidate = candidateData[candidateId];
  if (!candidate) {
    console.log(`Candidate data not found for ID: ${candidateId}`);
    return res.status(404).json({ error: 'Candidate data not found' });
  }

  // Generate question or response based on parsed data
  let responseText;
  if (candidate.skills.length > 0 && message.toLowerCase().includes('experience')) {
    responseText = `Can you describe a project where you used ${candidate.skills[0]}?`;
  } else if (candidate.skills.length > 0 && message.toLowerCase().includes(candidate.skills[0]?.toLowerCase())) {
    responseText = `Great! How many years of experience do you have with ${candidate.skills[0]}?`;
  } else {
    responseText = `Thanks for your response. Can you tell me more about your ${candidate.skills[0] || 'recent work'} experience?`;
  }

  console.log(`Chat response for candidate ${candidateId}: ${responseText}`);
  res.json({ response: responseText });
});

// Serve static files (optional)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});