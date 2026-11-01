// ============================================================
// RepoVerse — Search, Discovery, Pathfinding & MCP Engine
// ============================================================

class SearchEngine {
  constructor(repos, categories, relationships) {
    this.repos = repos;
    this.categories = categories;
    this.relationships = relationships;

    this.adjList = new Map();
    this.centralityMap = new Map();

    this._buildGraphIndex();
    this._calculateCentrality();
  }

  _buildGraphIndex() {
    this.repos.forEach(repo => {
      this.adjList.set(repo.id, []);
    });

    this.relationships.forEach(rel => {
      if (this.adjList.has(rel.source) && this.adjList.has(rel.target)) {
        this.adjList.get(rel.source).push({ target: rel.target, type: rel.type, direction: 'outgoing' });
        this.adjList.get(rel.target).push({ target: rel.source, type: rel.type, direction: 'incoming' });
      }
    });

    // Synonym map for rich intent recognition
    this.synonyms = {
      'k8s': 'kubernetes',
      'db': 'database postgres storage sql',
      'ai': 'llm agents neural machine learning',
      'ml': 'machine learning deep learning pytorch',
      'rag': 'embeddings vector similarity search',
      'orm': 'database prisma sql',
      'gui': 'frontend ui components react',
      'paas': 'self-hosted cloud deploy heroku',
      'vps': 'coolify docker server deploy',
      'mcp': 'model context protocol tools agents',
      'cache': 'redis in-memory fast',
      'fast': 'high-performance rust blazing sub-millisecond',
      'offline': 'local private ollama',
      'agent': 'autonomous langchain crewai mem0',
      'agents': 'autonomous multi-agent orchestration',
      'eth': 'ethereum solidity evm',
      'ethereum': 'evm solidity smart-contracts',
      'web3': 'ethereum dapp wallet blockchain',
      'crypto': 'blockchain wallet bitcoin ethereum defi',
      'blockchain': 'ethereum bitcoin solana smart-contracts',
      'dapp': 'ethereum wallet wagmi viem',
      'nft': 'erc721 smart-contracts ipfs',
      'token': 'erc20 smart-contracts',
      'contract': 'smart-contracts solidity',
      'contracts': 'smart-contracts solidity',
      'audit': 'smart-contract-audit security static-analysis',
      'pentest': 'penetration exploitation vulnerability-scanner',
      'hacking': 'pentest ctf payloads',
      'secrets': 'secret-scanning api-keys credentials',
      'pii': 'redaction anonymization privacy presidio',
      'dpdp': 'pii privacy redaction compliance',
      'privacy': 'pii redaction anonymization',
      'guardrails': 'llm-safety prompt-injection jailbreak',
      'injection': 'prompt-injection sql-injection',
      'eval': 'evals benchmarks testing',
      'auth': 'authentication identity sso oauth2',
      'login': 'authentication sessions oauth',
      'sso': 'identity oauth2 oidc',
      'copilot': 'coding-agent autocomplete ide-assistant',
      'coding': 'coding-agent ide-assistant',
      'claude': 'anthropic claude-code mcp',
      'chatbot': 'chat-ui chatbot-builder whatsapp',
      'whatsapp': 'chatbot automation',
      'image': 'image-generation stable-diffusion computer-vision',
      'video': 'video-generation ffmpeg streaming',
      'speech': 'speech-to-text text-to-speech whisper',
      'voice': 'text-to-speech voice-cloning speech-to-text',
      'ocr': 'document-processing text-recognition',
      'pdf': 'document-conversion pdf-tools ocr',
      'etl': 'elt data-integration orchestration pipelines',
      'pipeline': 'orchestration etl dag',
      'streaming': 'event-streaming kafka real-time',
      'queue': 'message-broker task-queue job-queue',
      'bi': 'dashboards analytics visualization',
      'dashboard': 'dashboards visualization admin-panels charts',
      'charts': 'visualization charts plotting',
      'test': 'testing e2e-testing unit-testing',
      'testing': 'e2e-testing unit-testing load-testing',
      'e2e': 'e2e-testing browser-automation playwright',
      'scraping': 'web-scraping crawler browser-automation',
      'scrape': 'web-scraping crawler',
      'cms': 'headless-cms blog static-site-generator',
      'blog': 'blogging cms static-site-generator',
      'shop': 'ecommerce online-store',
      'store': 'ecommerce online-store storage',
      'ecommerce': 'online-store headless-commerce',
      'crm': 'customer sales salesforce-alternative',
      'erp': 'accounting inventory business',
      'nocode': 'no-code low-code',
      'no-code': 'low-code drag-drop',
      'lowcode': 'low-code internal-tools',
      'automation': 'workflow-automation zapier-alternative',
      'game': 'game-engine games 2d 3d',
      'games': 'game-engine html5-games',
      '3d': 'webgl three-js 3d-modeling',
      'terminal': 'cli shell tui terminal-emulator',
      'shell': 'zsh terminal prompt',
      'editor': 'ide neovim vim',
      'learn': 'learning course tutorials roadmap books',
      'course': 'learning tutorials',
      'interview': 'interview-prep system-design algorithms',
      'roadmap': 'roadmaps learning-path career',
      'awesome': 'awesome-list curated directory',
      'selfhosted': 'self-hosted',
      'self-hosted': 'self-hosted alternative',
      'mobile': 'ios android cross-platform react-native flutter',
      'desktop': 'electron tauri cross-platform',
      'android': 'mobile kotlin',
      'ios': 'mobile swift',
      'monitoring': 'metrics observability alerting uptime-monitoring',
      'logs': 'log-aggregation logging observability',
      'analytics': 'web-analytics product-analytics olap',
      'search': 'search-engine full-text vector-search',
      'vector': 'vector-db embeddings similarity-search',
      'llm': 'inference local-ai agents rag',
      'finetune': 'fine-tuning lora',
      'fine-tune': 'fine-tuning lora',
      'payments': 'payments upi stripe',
      'upi': 'payments india',
    };

    // Filler words people type when describing what they need
    this.stopwords = new Set(['i', 'want', 'need', 'to', 'a', 'an', 'the', 'for', 'of', 'and', 'or', 'with', 'in', 'on',
      'my', 'me', 'how', 'can', 'build', 'make', 'create', 'best', 'tool', 'tools', 'repo', 'repos', 'library',
      'framework', 'something', 'that', 'is', 'are', 'app', 'use', 'using', 'get', 'find', 'like', 'some', 'good', 'top']);

    this.categoryById = new Map(this.categories.map(c => [c.id, c]));
  }

  getCategoryName(catId) {
    return this.categoryById.get(catId)?.name || catId;
  }

  _calculateCentrality() {
    // Degree centrality & Gateway identification
    this.repos.forEach(repo => {
      const neighbors = this.adjList.get(repo.id) || [];
      const degree = neighbors.length;
      const starWeight = Math.log10(Math.max(repo.stars, 1000));
      const score = Math.round((degree * 2.5 + starWeight * 1.5) * 10) / 10;
      this.centralityMap.set(repo.id, { degree, score });
    });
  }

  getCentrality(repoId) {
    return this.centralityMap.get(repoId) || { degree: 0, score: 0 };
  }

  /**
   * Intent-based search with semantic scoring
   */
  search(query, limit = 40) {
    if (!query || query.trim().length === 0) return [];

    const phrase = query.toLowerCase().trim();
    const allTerms = phrase.split(/[\s,]+/).filter(Boolean);
    const meaningful = allTerms.filter(t => !this.stopwords.has(t));
    const rawTerms = meaningful.length ? meaningful : allTerms;

    // Synonym expansions score lower than what the user actually typed
    const expandedTerms = [];
    rawTerms.forEach(t => {
      if (this.synonyms[t]) {
        this.synonyms[t].split(' ').forEach(s => {
          if (!rawTerms.includes(s) && !expandedTerms.includes(s)) expandedTerms.push(s);
        });
      }
    });

    // Short terms ("ai", "ui", "go") match whole words only, so "ai" doesn't hit "maintain"
    const boundary = new Map();
    const has = (text, term) => {
      if (term.length > 3) return text.includes(term);
      if (!boundary.has(term)) boundary.set(term, new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`));
      return boundary.get(term).test(text);
    };

    const scored = this.repos.map(repo => {
      let score = 0;
      const reasons = [];

      const repoNameLower = repo.name.toLowerCase();
      const repoDescLower = repo.desc.toLowerCase();
      const repoLangLower = (repo.language || '').toLowerCase();
      const repoTagsLower = (repo.tags || []).map(t => t.toLowerCase());
      const repoUseCasesLower = (repo.useCases || []).map(u => u.toLowerCase());
      const repoFullLower = (repo.fullName || '').toLowerCase();
      const cat = this.categoryById.get(repo.category);
      const catText = cat ? `${cat.id} ${cat.name} ${cat.desc}`.toLowerCase() : '';

      // Whole-phrase match against use cases ("smart contract", "local llm")
      if (rawTerms.length > 1) {
        const core = rawTerms.join(' ');
        if (repoUseCasesLower.some(uc => uc.includes(core)) || repoDescLower.includes(core)) {
          score += 60;
          reasons.push(`Phrase match: "${core}"`);
        }
        // Two-word phrases ("system design", "secret scanning") anywhere in the query
        const haystack = `${repoNameLower} ${repoDescLower} ${repoUseCasesLower.join(' ')} ${repoTagsLower.join(' ').replace(/-/g, ' ')}`;
        for (let i = 0; i < rawTerms.length - 1; i++) {
          const bigram = `${rawTerms[i]} ${rawTerms[i + 1]}`;
          if (bigram !== core && haystack.includes(bigram)) {
            score += 45;
            reasons.push(`Phrase match: "${bigram}"`);
          }
        }
      }

      expandedTerms.forEach(term => {
        if (repoTagsLower.includes(term)) score += 14;
        else if (repoTagsLower.some(t => has(t, term))) score += 6;
        if (repoUseCasesLower.some(uc => has(uc, term))) score += 8;
        if (repoNameLower === term) score += 30;
      });

      rawTerms.forEach(term => {
        // Niche match: typing a niche ("web3", "security", "testing") surfaces its repos
        if (catText && (repo.category === term || catText.split(/[\s,&/]+/).includes(term))) {
          score += 18;
          if (!reasons.length) reasons.push(`Niche: ${cat.name}`);
        }

        if (has(repoFullLower, term) && !has(repoNameLower, term)) {
          score += 10;
        }

        // Direct exact name match
        if (repoNameLower === term) {
          score += 120;
          reasons.push(`Exact name match: "${repo.name}"`);
        } else if (repoNameLower.startsWith(term)) {
          score += 60;
          reasons.push(`Name prefix: "${term}"`);
        } else if (has(repoNameLower, term)) {
          score += 35;
        }

        // Tag matches
        if (repoTagsLower.includes(term)) {
          score += 40;
          reasons.push(`Tag: #${term}`);
        } else if (repoTagsLower.some(t => has(t, term))) {
          score += 20;
        }

        // Use case matches (Intent discovery)
        const ucHit = repoUseCasesLower.find(uc => has(uc, term));
        if (ucHit) {
          score += 35;
          reasons.push(`Intent match: "${ucHit}"`);
        }

        // Language match
        if (repoLangLower === term) {
          score += 30;
          reasons.push(`Language: ${repo.language}`);
        }

        // Description match
        if (has(repoDescLower, term)) {
          score += 15;
        }

        // MCP match
        if (term === 'mcp' && repo.isMcpReady) {
          score += 50;
          reasons.push('MCP-Ready tool');
        }
      });

      if (score > 0) {
        // Boost for gateway anchor repos
        if (repo.isGateway) score += 8;
        // Star bonus (logarithmic)
        score += Math.log10(Math.max(repo.stars, 10)) * 2;
      }

      return {
        repo,
        score,
        matchReason: [...new Set(reasons)].slice(0, 2).join(' • ') || 'Related keywords',
      };
    });

    return scored
      .filter(s => s.score > 12)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Mechanism 4: Shortest Pathfinding Engine (Breadth-First Search)
   */
  findPath(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return null;

    const queue = [[sourceId]];
    const visited = new Set([sourceId]);
    const edgeTypes = new Map(); // key: "s->t", value: type

    // Prepopulate edge dictionary
    this.relationships.forEach(r => {
      edgeTypes.set(`${r.source}->${r.target}`, r.type);
      edgeTypes.set(`${r.target}->${r.source}`, r.type);
    });

    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];

      if (current === targetId) {
        // Build detailed path steps
        const steps = [];
        for (let i = 0; i < path.length; i++) {
          const repo = this.repos.find(r => r.id === path[i]);
          let edgeType = null;
          if (i > 0) {
            edgeType = edgeTypes.get(`${path[i - 1]}->${path[i]}`) || 'connected-to';
          }
          steps.push({ repo, edgeType });
        }
        return { path, steps, distance: path.length - 1 };
      }

      const neighbors = this.adjList.get(current) || [];
      for (const { target } of neighbors) {
        if (!visited.has(target)) {
          visited.add(target);
          queue.push([...path, target]);
        }
      }
    }

    return null; // No path found
  }

  /**
   * Dynamic Multi-Faceted Filters
   */
  filterRepos({ category, language, starTier, license, mcpOnly, gatewayOnly }) {
    return this.repos.filter(repo => {
      if (category && repo.category !== category) return false;
      if (language && repo.language !== language) return false;
      if (license && repo.license !== license) return false;
      if (mcpOnly && !repo.isMcpReady) return false;
      if (gatewayOnly && !repo.isGateway) return false;

      if (starTier) {
        if (starTier === 'titans' && repo.stars < 100000) return false;
        if (starTier === 'pillars' && (repo.stars < 50000 || repo.stars >= 100000)) return false;
        if (starTier === 'rising' && (repo.stars < 10000 || repo.stars >= 50000)) return false;
        if (starTier === 'gems' && repo.stars >= 10000) return false;
      }

      return true;
    });
  }

  /**
   * Mechanism 6: MCP Agent Tool Execution Simulator
   */
  executeMcpTool(toolName, args = {}) {
    const timestamp = new Date().toISOString();

    switch (toolName) {
      case 'search_repositories': {
        const query = args.query || args.intent || '';
        const results = this.search(query).map(r => ({
          id: r.repo.id,
          name: r.repo.name,
          category: r.repo.category,
          stars: r.repo.stars,
          language: r.repo.language,
          desc: r.repo.desc,
          matchReason: r.matchReason,
          isMcpReady: r.repo.isMcpReady,
        }));
        return {
          status: 'success',
          tool: toolName,
          timestamp,
          count: results.length,
          data: results,
        };
      }

      case 'get_repo_details': {
        const repo = this.repos.find(r => r.id === args.repo_id);
        if (!repo) {
          return { status: 'error', tool: toolName, error: `Repository '${args.repo_id}' not found.` };
        }
        const neighbors = (this.adjList.get(repo.id) || []).map(n => ({
          target: n.target,
          relationship: n.type,
          direction: n.direction,
        }));
        return {
          status: 'success',
          tool: toolName,
          timestamp,
          data: {
            ...repo,
            centrality: this.getCentrality(repo.id),
            connections: neighbors,
          },
        };
      }

      case 'trace_connection_path': {
        const pathData = this.findPath(args.source_repo, args.target_repo);
        if (!pathData) {
          return {
            status: 'success',
            tool: toolName,
            timestamp,
            data: { connected: false, message: 'No direct connection path found.' },
          };
        }
        return {
          status: 'success',
          tool: toolName,
          timestamp,
          data: {
            connected: true,
            distance: pathData.distance,
            path: pathData.steps.map(s => ({
              repoId: s.repo.id,
              name: s.repo.name,
              via: s.edgeType,
            })),
          },
        };
      }

      case 'get_ecosystem_cluster': {
        const category = args.category;
        const reposInCat = this.repos.filter(r => r.category === category);
        return {
          status: 'success',
          tool: toolName,
          timestamp,
          data: {
            category,
            totalRepos: reposInCat.length,
            repos: reposInCat.map(r => ({ id: r.id, name: r.name, stars: r.stars, desc: r.desc })),
          },
        };
      }

      case 'export_mcp_graph_schema': {
        return {
          status: 'success',
          tool: toolName,
          timestamp,
          data: {
            nodeCount: this.repos.length,
            edgeCount: this.relationships.length,
            categories: this.categories.map(c => c.id),
            schema: {
              nodeProperties: ['id', 'name', 'stars', 'language', 'category', 'license', 'tags', 'useCases', 'isMcpReady'],
              edgeTypes: ['works-with', 'alternative-to', 'depends-on'],
            },
          },
        };
      }

      default:
        return { status: 'error', tool: toolName, error: `Unknown tool '${toolName}'.` };
    }
  }

  static formatStars(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(count >= 10000 ? 0 : 1) + 'k';
    return count.toString();
  }
}
