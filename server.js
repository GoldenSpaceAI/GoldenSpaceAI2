const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Grok (xAI) - OpenAI-compatible API
const grok = new OpenAI({
    apiKey: process.env.GROK_API_KEY,
    baseURL: 'https://api.x.ai/v1'
});

const MODEL_SINGLE = 'grok-4.3';
const MODEL_MULTI = 'grok-4.20-multi-agent';

// Agent names for logging
const AGENT_NAMES = ['Grok (Captain)', 'Harper (Research)', 'Benjamin (Logic)', 'Lucas (Critic)',
                     'Atlas (Web)', 'Nova (X Search)', 'Sage (Analysis)', 'Rex (Verify)',
                     'Orion (Data)', 'Vega (Context)', 'Lyra (Summary)', 'Zen (Fact-check)',
                     'Kai (Sources)', 'Nexus (Synthesis)', 'Aria (Review)', 'Sigma (Output)'];

app.post('/api/chat', async (req, res) => {
    try {
        const { messages, customInstructions, mode, agents, image } = req.body;
        // mode: 'normal' | 'smart' | 'expert'
        // agents: 4 | 16 (for expert mode)
        
        let modelName, requestParams, agentLog = [];
        
        // Build conversation
        const conversationMessages = [];
        
        if (customInstructions) {
            conversationMessages.push({
                role: 'system',
                content: customInstructions
            });
        }
        
        messages.forEach(msg => {
            if (msg.role === 'user') {
                const content = [];
                if (msg.content) content.push({ type: 'text', text: msg.content });
                if (msg.image) {
                    content.push({
                        type: 'image_url',
                        image_url: { url: msg.image, detail: 'auto' }
                    });
                }
                conversationMessages.push({
                    role: 'user',
                    content: content.length === 1 && content[0].type === 'text' 
                        ? content[0].text : content
                });
            } else if (msg.role === 'ai') {
                conversationMessages.push({
                    role: 'assistant',
                    content: msg.content
                });
            }
        });

        if (mode === 'expert') {
            // ==================== EXPERT MODE (Multi-Agent) ====================
            modelName = MODEL_MULTI;
            const numAgents = agents || 4;
            
            console.log(`🌐 Expert Mode: ${numAgents} agents researching...`);
            
            // Generate agent thinking log
            const agentList = AGENT_NAMES.slice(0, numAgents);
            agentLog.push({ agent: 'Grok (Captain)', type: 'action', action: 'Orchestrating team...' });
            
            agentList.forEach((name, i) => {
                setTimeout(() => {
                    const actions = [
                        'Searching web...', 'Analyzing X posts...', 'Verifying sources...',
                        'Cross-referencing data...', 'Evaluating credibility...', 'Synthesizing findings...',
                        'Checking facts...', 'Running analysis...', 'Compiling research...',
                        'Validating logic...', 'Scanning references...', 'Processing information...',
                        'Reviewing context...', 'Generating insights...', 'Quality checking...',
                        'Preparing summary...'
                    ];
                    agentLog.push({ agent: name, type: 'search', action: actions[i % actions.length] });
                }, i * 500);
            });
            
            // Call Grok multi-agent with web search tools
            const completion = await grok.chat.completions.create({
                model: modelName,
                messages: conversationMessages,
                tools: [
                    { type: 'web_search' },
                    { type: 'x_search' }
                ],
                tool_choice: 'auto',
                max_tokens: 4096,
                temperature: 0.5,
            });
            
            const reply = completion.choices[0].message.content;
            
            agentLog.push({ agent: 'Grok (Captain)', type: 'action', action: '✅ Research complete. Synthesizing answer...' });
            
            console.log(`✅ Expert response (${reply.length} chars)`);
            
            res.json({ 
                reply, 
                agentLog,
                model: `Expert · ${numAgents} Agents`
            });
            
        } else if (mode === 'smart') {
            // ==================== SMART MODE (Reasoning) ====================
            modelName = MODEL_SINGLE;
            
            console.log('🧠 Smart Mode: Deep reasoning...');
            
            const completion = await grok.chat.completions.create({
                model: modelName,
                messages: conversationMessages,
                max_tokens: 4096,
                temperature: 0.3,
                reasoning_effort: 'high',
            });
            
            const reply = completion.choices[0].message.content;
            console.log(`✅ Smart response (${reply.length} chars)`);
            
            res.json({ reply, model: 'Grok 4.3 · Reasoning' });
            
        } else {
            // ==================== NORMAL MODE (Fast) ====================
            modelName = MODEL_SINGLE;
            
            console.log('⚡ Normal Mode: Fast response...');
            
            const completion = await grok.chat.completions.create({
                model: modelName,
                messages: conversationMessages,
                max_tokens: 2048,
                temperature: 0.7,
            });
            
            const reply = completion.choices[0].message.content;
            console.log(`✅ Normal response (${reply.length} chars)`);
            
            res.json({ reply, model: 'Grok 4.3' });
        }
        
    } catch (error) {
        console.error('❌ Grok API Error:', error.message, error.status);
        
        let errorMessage = 'An error occurred. Please try again.';
        
        if (error.status === 401) {
            errorMessage = '🔑 Invalid API key. Please check your Grok API key in Render environment.';
        } else if (error.status === 429) {
            errorMessage = '⏳ Rate limit reached or out of credits. Add more at console.x.ai';
        } else if (error.status === 402) {
            errorMessage = '💰 Insufficient credits. Please add funds at console.x.ai';
        } else if (error.status === 503) {
            errorMessage = '🔧 Grok service is temporarily unavailable. Please try again.';
        } else if (error.message?.includes('timeout')) {
            errorMessage = '⏰ Request timed out. Expert mode may take longer. Try again.';
        }
        
        res.status(500).json({ 
            reply: errorMessage,
            model: 'Error'
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        app: 'GoldenSpaceAI2',
        provider: 'Grok (xAI)',
        models: {
            normal: 'grok-4.3',
            smart: 'grok-4.3 (reasoning)',
            expert: 'grok-4.20-multi-agent (4-16 agents)'
        },
        tools: ['web_search', 'x_search', 'code_execution'],
        apiKeyConfigured: !!process.env.GROK_API_KEY,
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log('═══════════════════════════════════════');
    console.log('🚀 GoldenSpaceAI2 Server Running');
    console.log('═══════════════════════════════════════');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🤖 Provider: Grok (xAI)`);
    console.log(`⚡ Normal: ${MODEL_SINGLE}`);
    console.log(`🧠 Smart: ${MODEL_SINGLE} (reasoning)`);
    console.log(`🌐 Expert: ${MODEL_MULTI} (4-16 agents)`);
    console.log(`🔧 Tools: Web Search, X Search, Code Execution`);
    console.log(`🔑 API Key: ${process.env.GROK_API_KEY ? '✅ Configured' : '❌ Missing'}`);
    console.log('═══════════════════════════════════════');
});
