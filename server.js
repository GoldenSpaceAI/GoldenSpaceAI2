const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let grok;
try {
    grok = new OpenAI({
        apiKey: process.env.GROK_API_KEY || 'missing-key',
        baseURL: 'https://api.x.ai/v1'
    });
} catch(e) {
    console.error('Failed to initialize Grok client:', e.message);
}

const MODELS = {
    normal: { model: 'grok-4.3', maxTokens: 2048, temperature: 0.7 },
    smart: { model: 'grok-4.3', maxTokens: 4096, temperature: 0.3 },
    expert: { model: 'grok-4.20-multi-agent', maxTokens: 4096, temperature: 0.5 }
};

app.post('/api/chat', async (req, res) => {
    try {
        const { messages, customInstructions, mode, agents, image } = req.body;
        
        if (!process.env.GROK_API_KEY) {
            return res.status(500).json({ 
                reply: '⚠️ Grok API key not configured.',
                model: 'Error'
            });
        }
        
        const conversationMessages = [];
        
        if (customInstructions && customInstructions.trim()) {
            conversationMessages.push({
                role: 'system',
                content: customInstructions.trim()
            });
        }
        
        if (messages && Array.isArray(messages)) {
            messages.forEach(msg => {
                if (!msg || !msg.role) return;
                
                if (msg.role === 'user') {
                    const content = [];
                    if (msg.content && msg.content.trim()) {
                        content.push({ type: 'text', text: msg.content.trim() });
                    }
                    if (msg.image && !msg.imageTooBig) {
                        content.push({
                            type: 'image_url',
                            image_url: { url: msg.image, detail: 'auto' }
                        });
                    }
                    if (content.length > 0) {
                        conversationMessages.push({
                            role: 'user',
                            content: content.length === 1 && content[0].type === 'text' 
                                ? content[0].text 
                                : content
                        });
                    }
                } else if (msg.role === 'ai' || msg.role === 'assistant') {
                    if (msg.content && msg.content.trim()) {
                        conversationMessages.push({
                            role: 'assistant',
                            content: msg.content.trim()
                        });
                    }
                }
            });
        }
        
        if (image && !messages?.some(m => m.image === image)) {
            const lastMsg = conversationMessages[conversationMessages.length - 1];
            if (lastMsg && lastMsg.role === 'user') {
                if (typeof lastMsg.content === 'string') {
                    lastMsg.content = [
                        { type: 'text', text: lastMsg.content },
                        { type: 'image_url', image_url: { url: image, detail: 'auto' } }
                    ];
                } else if (Array.isArray(lastMsg.content)) {
                    lastMsg.content.push({ type: 'image_url', image_url: { url: image, detail: 'auto' } });
                }
            } else {
                conversationMessages.push({
                    role: 'user',
                    content: [{ type: 'image_url', image_url: { url: image, detail: 'auto' } }]
                });
            }
        }
        
        if (conversationMessages.length === 0) {
            conversationMessages.push({ role: 'user', content: 'Hello' });
        }
        
        const systemMessages = conversationMessages.filter(m => m.role === 'system');
        if (systemMessages.length > 1) {
            const firstSystem = conversationMessages.findIndex(m => m.role === 'system');
            for (let i = conversationMessages.length - 1; i >= 0; i--) {
                if (conversationMessages[i].role === 'system' && i !== firstSystem) {
                    conversationMessages.splice(i, 1);
                }
            }
        }
        
        const safeMode = mode || 'normal';
        const config = MODELS[safeMode] || MODELS.normal;
        
        console.log(`🤖 Mode: ${safeMode} | Model: ${config.model}`);
        
        let completion;
        
        if (safeMode === 'expert') {
            console.log(`🌐 Expert mode with ${agents || 4} agents`);
            
            completion = await grok.chat.completions.create({
                model: config.model,
                messages: conversationMessages,
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'web_search',
                            description: 'Search the web for current information',
                            parameters: {
                                type: 'object',
                                properties: {
                                    query: {
                                        type: 'string',
                                        description: 'The search query'
                                    }
                                },
                                required: ['query']
                            }
                        }
                    },
                    {
                        type: 'function',
                        function: {
                            name: 'x_search',
                            description: 'Search X (Twitter) for posts',
                            parameters: {
                                type: 'object',
                                properties: {
                                    query: {
                                        type: 'string',
                                        description: 'The search query'
                                    }
                                },
                                required: ['query']
                            }
                        }
                    }
                ],
                tool_choice: 'auto',
                max_tokens: config.maxTokens,
                temperature: config.temperature,
            });
            
        } else if (safeMode === 'smart') {
            completion = await grok.chat.completions.create({
                model: config.model,
                messages: conversationMessages,
                max_tokens: config.maxTokens,
                temperature: config.temperature,
                reasoning_effort: 'high',
            });
            
        } else {
            completion = await grok.chat.completions.create({
                model: config.model,
                messages: conversationMessages,
                max_tokens: config.maxTokens,
                temperature: config.temperature,
            });
        }
        
        const reply = completion?.choices?.[0]?.message?.content || 'No response generated.';
        
        console.log(`✅ Response: ${reply.length} chars`);
        
        res.json({ reply, model: safeMode });
        
    } catch (error) {
        console.error('❌ Grok API Error:', error.message, error.status);
        
        let errorMessage = 'An error occurred. Please try again.';
        let statusCode = 500;
        
        if (error.status === 401) {
            errorMessage = '🔑 Invalid API key.';
        } else if (error.status === 429) {
            errorMessage = '⏳ Rate limited or out of credits.';
        } else if (error.status === 402) {
            errorMessage = '💰 Out of credits.';
        } else if (error.status === 422) {
            errorMessage = '⚠️ Invalid request. Try a different mode.';
        } else if (error.status === 503) {
            errorMessage = '🔧 Grok service unavailable.';
        } else if (error.message?.includes('timeout')) {
            errorMessage = '⏰ Request timed out.';
        } else if (error.message) {
            errorMessage = '⚠️ ' + error.message.substring(0, 100);
        }
        
        res.status(statusCode).json({ reply: errorMessage, model: 'Error' });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        app: 'GoldenSpaceAI2',
        provider: 'Grok (xAI)',
        apiKeyConfigured: !!process.env.GROK_API_KEY
    });
});

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    res.status(500).json({ reply: '⚠️ Server error.' });
});

app.listen(PORT, () => {
    console.log('═══════════════════════════════');
    console.log('🚀 GoldenSpaceAI2 Server');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🤖 Grok (xAI)`);
    console.log(`🔑 Key: ${process.env.GROK_API_KEY ? '✅' : '❌'}`);
    console.log('═══════════════════════════════');
});
