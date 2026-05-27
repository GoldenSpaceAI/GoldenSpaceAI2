const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Gemini API setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Models
const FLASH_MODEL = 'gemini-2.0-flash';
const PRO_MODEL = 'gemini-2.5-pro';

app.post('/api/chat', async (req, res) => {
    try {
        const { messages, customInstructions, smartMode, image } = req.body;
        
        // Choose model based on smart mode
        const modelName = smartMode ? PRO_MODEL : FLASH_MODEL;
        const model = genAI.getGenerativeModel({ model: modelName });
        
        // Build conversation history
        const conversationParts = [];
        
        // Add custom instructions as system context
        if (customInstructions) {
            conversationParts.push({
                role: 'user',
                parts: [{ text: `System instructions: ${customInstructions}\n\nPlease follow these instructions for all responses.` }]
            });
            conversationParts.push({
                role: 'model',
                parts: [{ text: 'I understand and will follow these instructions.' }]
            });
        }
        
        // Add last 5 messages
        messages.forEach(msg => {
            if (msg.role === 'user') {
                const parts = [];
                
                // Add image if present
                if (msg.image) {
                    const base64Data = msg.image.split(',')[1];
                    parts.push({
                        inlineData: {
                            mimeType: 'image/jpeg',
                            data: base64Data
                        }
                    });
                }
                
                // Add text if present
                if (msg.content) {
                    parts.push({ text: msg.content });
                }
                
                conversationParts.push({
                    role: 'user',
                    parts: parts
                });
            } else if (msg.role === 'ai') {
                conversationParts.push({
                    role: 'model',
                    parts: [{ text: msg.content }]
                });
            }
        });
        
        // Generate response
        const result = await model.generateContent({
            contents: conversationParts,
            generationConfig: {
                temperature: smartMode ? 0.7 : 0.9,
                topP: 0.95,
                topK: 40,
                maxOutputTokens: smartMode ? 2048 : 1024,
            }
        });
        
        const response = result.response;
        const text = response.text();
        
        res.json({ reply: text });
        
    } catch (error) {
        console.error('Gemini API Error:', error);
        
        // Better error handling
        let errorMessage = 'Sorry, I encountered an error. Please try again.';
        
        if (error.message?.includes('API key')) {
            errorMessage = 'API key error. Please check the server configuration.';
        } else if (error.message?.includes('quota')) {
            errorMessage = 'API quota exceeded. Please try again later.';
        } else if (error.message?.includes('blocked')) {
            errorMessage = 'Content blocked by safety filters. Please rephrase your message.';
        }
        
        res.status(500).json({ reply: errorMessage });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', model: 'GoldenSpaceAI2' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 GoldenSpaceAI2 server running on port ${PORT}`);
    console.log(`📱 Smart Mode OFF: ${FLASH_MODEL}`);
    console.log(`🧠 Smart Mode ON: ${PRO_MODEL}`);
    console.log(`🔑 API Key configured: ${process.env.GEMINI_API_KEY ? '✅ Yes' : '❌ No'}`);
});
