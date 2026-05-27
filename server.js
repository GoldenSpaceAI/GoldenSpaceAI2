const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Grok (xAI) setup
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

// ==================== COMPLETE MATH CLEANER ====================
function cleanLatex(text) {
    if (!text) return text;
    
    // First handle fractions, sqrt, and other multi-arg commands before generic replacements
    return text
        // Remove \boxed{...} wrapper
        .replace(/\\boxed\{([^}]+)\}/g, '$1')
        
        // Greek letters (lowercase)
        .replace(/\\alpha\b/g, 'α')
        .replace(/\\beta\b/g, 'β')
        .replace(/\\gamma\b/g, 'γ')
        .replace(/\\delta\b/g, 'δ')
        .replace(/\\epsilon\b/g, 'ε')
        .replace(/\\zeta\b/g, 'ζ')
        .replace(/\\eta\b/g, 'η')
        .replace(/\\theta\b/g, 'θ')
        .replace(/\\iota\b/g, 'ι')
        .replace(/\\kappa\b/g, 'κ')
        .replace(/\\lambda\b/g, 'λ')
        .replace(/\\mu\b/g, 'μ')
        .replace(/\\nu\b/g, 'ν')
        .replace(/\\xi\b/g, 'ξ')
        .replace(/\\omicron\b/g, 'ο')
        .replace(/\\pi\b/g, 'π')
        .replace(/\\rho\b/g, 'ρ')
        .replace(/\\sigma\b/g, 'σ')
        .replace(/\\tau\b/g, 'τ')
        .replace(/\\upsilon\b/g, 'υ')
        .replace(/\\phi\b/g, 'φ')
        .replace(/\\chi\b/g, 'χ')
        .replace(/\\psi\b/g, 'ψ')
        .replace(/\\omega\b/g, 'ω')
        
        // Greek letters (uppercase)
        .replace(/\\Gamma\b/g, 'Γ')
        .replace(/\\Delta\b/g, 'Δ')
        .replace(/\\Theta\b/g, 'Θ')
        .replace(/\\Lambda\b/g, 'Λ')
        .replace(/\\Xi\b/g, 'Ξ')
        .replace(/\\Pi\b/g, 'Π')
        .replace(/\\Sigma\b/g, 'Σ')
        .replace(/\\Phi\b/g, 'Φ')
        .replace(/\\Psi\b/g, 'Ψ')
        .replace(/\\Omega\b/g, 'Ω')
        
        // Math symbols
        .replace(/\\pm\b/g, '±')
        .replace(/\\mp\b/g, '∓')
        .replace(/\\times\b/g, '×')
        .replace(/\\div\b/g, '÷')
        .replace(/\\cdot\b/g, '·')
        .replace(/\\ast\b/g, '*')
        .replace(/\\star\b/g, '★')
        .replace(/\\circ\b/g, '°')
        .replace(/\\bullet\b/g, '•')
        .replace(/\\oplus\b/g, '⊕')
        .replace(/\\ominus\b/g, '⊖')
        .replace(/\\otimes\b/g, '⊗')
        .replace(/\\oslash\b/g, '⊘')
        .replace(/\\odot\b/g, '⊙')
        
        // Relations
        .replace(/\\leq\b/g, '≤')
        .replace(/\\geq\b/g, '≥')
        .replace(/\\neq\b/g, '≠')
        .replace(/\\approx\b/g, '≈')
        .replace(/\\equiv\b/g, '≡')
        .replace(/\\sim\b/g, '∼')
        .replace(/\\simeq\b/g, '≃')
        .replace(/\\cong\b/g, '≅')
        .replace(/\\propto\b/g, '∝')
        .replace(/\\parallel\b/g, '∥')
        .replace(/\\perp\b/g, '⊥')
        .replace(/\\ll\b/g, '≪')
        .replace(/\\gg\b/g, '≫')
        
        // Arrows
        .replace(/\\rightarrow\b/g, '→')
        .replace(/\\to\b/g, '→')
        .replace(/\\leftarrow\b/g, '←')
        .replace(/\\Rightarrow\b/g, '⇒')
        .replace(/\\Leftarrow\b/g, '⇐')
        .replace(/\\leftrightarrow\b/g, '↔')
        .replace(/\\uparrow\b/g, '↑')
        .replace(/\\downarrow\b/g, '↓')
        
        // Sets & logic
        .replace(/\\in\b/g, '∈')
        .replace(/\\notin\b/g, '∉')
        .replace(/\\subset\b/g, '⊂')
        .replace(/\\supset\b/g, '⊃')
        .replace(/\\subseteq\b/g, '⊆')
        .replace(/\\supseteq\b/g, '⊇')
        .replace(/\\cup\b/g, '∪')
        .replace(/\\cap\b/g, '∩')
        .replace(/\\emptyset\b/g, '∅')
        .replace(/\\forall\b/g, '∀')
        .replace(/\\exists\b/g, '∃')
        .replace(/\\neg\b/g, '¬')
        .replace(/\\land\b/g, '∧')
        .replace(/\\lor\b/g, '∨')
        .replace(/\\implies\b/g, '⇒')
        .replace(/\\iff\b/g, '⇔')
        
        // Calculus
        .replace(/\\int\b/g, '∫')
        .replace(/\\iint\b/g, '∬')
        .replace(/\\iiint\b/g, '∭')
        .replace(/\\oint\b/g, '∮')
        .replace(/\\sum\b/g, 'Σ')
        .replace(/\\prod\b/g, '∏')
        .replace(/\\partial\b/g, '∂')
        .replace(/\\nabla\b/g, '∇')
        .replace(/\\infty\b/g, '∞')
        .replace(/\\lim\b/g, 'lim')
        
        // Other symbols
        .replace(/\\angle\b/g, '∠')
        .replace(/\\triangle\b/g, '△')
        .replace(/\\square\b/g, '□')
        .replace(/\\checkmark\b/g, '✓')
        .replace(/\\cdot\b/g, '·')
        .replace(/\\ldots\b/g, '…')
        .replace(/\\cdots\b/g, '⋯')
        .replace(/\\vdots\b/g, '⋮')
        .replace(/\\ddots\b/g, '⋱')
        
        // Functions
        .replace(/\\sin\b/g, 'sin')
        .replace(/\\cos\b/g, 'cos')
        .replace(/\\tan\b/g, 'tan')
        .replace(/\\log\b/g, 'log')
        .replace(/\\ln\b/g, 'ln')
        .replace(/\\det\b/g, 'det')
        .replace(/\\gcd\b/g, 'gcd')
        .replace(/\\max\b/g, 'max')
        .replace(/\\min\b/g, 'min')
        
        // Fractions: \frac{a}{b} → (a)/(b)
        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1)/($2)')
        
        // Square root: \sqrt{x} → √(x)
        .replace(/\\sqrt\{([^}]+)\}/g, '√($1)')
        .replace(/\\sqrt\b/g, '√')
        
        // Nth root: \sqrt[n]{x} → ⁿ√(x) - but keep simple
        .replace(/\\sqrt\[([^\]]+)\]\{([^}]+)\}/g, '√($2)')
        
        // Superscripts: ^{...} → ^(...)
        .replace(/\^\{([^}]+)\}/g, '^($1)')
        // Subscripts: _{...} → _(...)
        .replace(/\_\{([^}]+)\}/g, '_($1)')
        
        // Text formatting
        .replace(/\\text\{([^}]+)\}/g, '$1')
        .replace(/\\textbf\{([^}]+)\}/g, '**$1**')
        .replace(/\\textit\{([^}]+)\}/g, '*$1*')
        .replace(/\\underline\{([^}]+)\}/g, '_$1_')
        .replace(/\\texttt\{([^}]+)\}/g, '`$1`')
        
        // Remove \displaystyle, \scriptstyle, etc.
        .replace(/\\displaystyle\b/g, '')
        .replace(/\\scriptstyle\b/g, '')
        .replace(/\\textstyle\b/g, '')
        
        // Remove \left, \right, \big, \Big etc. (size commands)
        .replace(/\\left\b/g, '')
        .replace(/\\right\b/g, '')
        .replace(/\\big\b/g, '')
        .replace(/\\Big\b/g, '')
        .replace(/\\bigg\b/g, '')
        .replace(/\\Bigg\b/g, '')
        
        // Remove math mode delimiters
        .replace(/\$\$/g, '')
        .replace(/\$/g, '')
        .replace(/\\\(\s*/g, '')
        .replace(/\s*\\\)/g, '')
        .replace(/\\\[\s*/g, '')
        .replace(/\s*\\\]/g, '')
        
        // Remove any remaining backslash commands (lone \command)
        .replace(/\\[a-zA-Z]+\b/g, '')
        
        // Clean up spacing
        .replace(/\s+/g, ' ')
        .replace(/\s+([.,!?;:)])/g, '$1')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .trim();
}

// ==================== MAIN CHAT ENDPOINT ====================
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
        
        const safeMode = mode || 'normal';
        const config = MODELS[safeMode] || MODELS.normal;
        
        console.log(`🤖 Mode: ${safeMode} | Model: ${config.model}`);
        
        let completion;
        
        if (safeMode === 'expert') {
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
                                    query: { type: 'string', description: 'The search query' }
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
                                    query: { type: 'string', description: 'The search query' }
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
        
        let reply = completion?.choices?.[0]?.message?.content || 'No response generated.';
        reply = cleanLatex(reply);
        
        console.log(`✅ Response: ${reply.length} chars`);
        res.json({ reply, model: safeMode });
        
    } catch (error) {
        console.error('❌ Grok API Error:', error.message, error.status);
        
        let errorMessage = 'An error occurred. Please try again.';
        if (error.status === 401) errorMessage = '🔑 Invalid API key.';
        else if (error.status === 429) errorMessage = '⏳ Rate limited or out of credits.';
        else if (error.status === 402) errorMessage = '💰 Out of credits.';
        else if (error.status === 422) errorMessage = '⚠️ Invalid request. Try a different mode.';
        else if (error.status === 503) errorMessage = '🔧 Grok service unavailable.';
        else if (error.message?.includes('timeout')) errorMessage = '⏰ Request timed out.';
        else if (error.message) errorMessage = '⚠️ ' + error.message.substring(0, 100);
        
        res.status(500).json({ reply: errorMessage, model: 'Error' });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        app: 'GoldenSpaceAI2',
        provider: 'Grok (xAI)',
        mathCleaner: true,
        apiKeyConfigured: !!process.env.GROK_API_KEY
    });
});

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
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
    console.log(`📐 Math Cleaner: ✅ Complete`);
    console.log(`🔑 Key: ${process.env.GROK_API_KEY ? '✅' : '❌'}`);
    console.log('═══════════════════════════════');
});
