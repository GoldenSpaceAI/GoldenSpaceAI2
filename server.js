const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// OpenAI setup
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Models
const NORMAL_MODEL = 'gpt-4o-mini';  // Cheap, fast, vision ✅
const SMART_MODEL = 'gpt-4o';        // Smart, deep reasoning, vision ✅

app.post('/api/chat', async (req, res) => {
    try {
        const { messages, customInstructions, smartMode, image } = req.body;
        
        // Choose model based on smart mode
        const modelName = smartMode ? SMART_MODEL : NORMAL_MODEL;
        console.log(`🤖 Using model: ${modelName} | Smart Mode: ${smartMode}`);
        
        // Build messages array for OpenAI
        const conversationMessages = [];
        
        // Add system message with custom instructions
        if (customInstructions) {
            conversationMessages.push({
                role: 'system',
                content: customInstructions
            });
        }
        
        // Add last 5 messages
        messages.forEach(msg => {
            if (msg.role === 'user') {
                const content = [];
                
                // Add text if present
                if (msg.content) {
                    content.push({
                        type: 'text',
                        text: msg.content
                    });
                }
                
                // Add image if present
                if (msg.image) {
                    content.push({
                        type: 'image_url',
                        image_url: {
                            url: msg.image,
                            detail: 'auto'
                        }
                    });
                }
                
                conversationMessages.push({
                    role: 'user',
                    content: content.length === 1 && content[0].type === 'text' 
                        ? content[0].text 
                        : content
                });
                
            } else if (msg.role === 'ai') {
                conversationMessages.push({
                    role: 'assistant',
                    content: msg.content
                });
            }
        });
        
        // If no messages, add a default
        if (conversationMessages.length === 0) {
            conversationMessages.push({
                role: 'user',
                content: 'Hello'
            });
        }
        
        // Call OpenAI
        const completion = await openai.chat.completions.create({
            model: modelName,
            messages: conversationMessages,
            max_tokens: smartMode ? 2048 : 1024,
            temperature: smartMode ? 0.7 : 0.9,
        });
        
        const reply = completion.choices[0].message.content;
        
        console.log(`✅ Response received (${reply.length} chars)`);
        
        res.json({ reply: reply });
        
    } catch (error) {
        console.error('OpenAI API Error:', error.message);
        
        let errorMessage = 'Sorry, I encountered an error. Please try again.';
        
        if (error.status === 401) {
            errorMessage = 'Invalid API key. Please check your OpenAI API key.';
        } else if (error.status === 429) {
            errorMessage = 'Rate limit exceeded or insufficient credits. Please check your OpenAI account.';
        } else if (error.status === 403) {
            errorMessage = 'API key does not have access to this model. Check your OpenAI account permissions.';
        }
        
        res.status(500).json({ reply: errorMessage });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        model: 'GoldenSpaceAI2',
        provider: 'OpenAI',
        normalModel: NORMAL_MODEL,
        smartModel: SMART_MODEL,
        apiKeyConfigured: !!process.env.OPENAI_API_KEY
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 GoldenSpaceAI2 server running on port ${PORT}`);
    console.log(`🤖 Provider: OpenAI`);
    console.log(`⚡ Normal Mode: ${NORMAL_MODEL} (Fast & Cheap)`);
    console.log(`🧠 Smart Mode: ${SMART_MODEL} (Deep Reasoning)`);
    console.log(`🔑 API Key configured: ${process.env.OPENAI_API_KEY ? '✅ Yes' : '❌ No'}`);
});
