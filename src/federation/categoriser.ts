/**
 * Pattern Categoriser — auto-categorises knowledge entries into a technology taxonomy.
 * Uses keyword matching only, no LLM calls.
 */

export interface CategoryMatch {
  category: string;
  subcategory: string;
  confidence: number; // 0-1
}

interface TaxonomyEntry {
  category: string;
  subcategory: string;
  keywords: string[];
}

const TAXONOMY: TaxonomyEntry[] = [
  // Languages
  { category: 'languages', subcategory: 'typescript', keywords: ['typescript', 'ts', 'tsc', 'tsconfig', '.ts ', 'type annotation', 'interface ', 'generic type', 'union type', 'type guard', 'discriminated union', 'mapped type', 'conditional type', 'utility type'] },
  { category: 'languages', subcategory: 'javascript', keywords: ['javascript', 'js', 'ecmascript', 'es6', 'es2015', 'promise', 'async await', 'prototype', 'closure', 'hoisting', 'event loop'] },
  { category: 'languages', subcategory: 'python', keywords: ['python', 'pip', 'pypi', 'virtualenv', 'venv', 'conda', 'pylint', 'mypy', 'pydantic', 'dataclass', 'decorator', 'generator', 'list comprehension', '__init__', 'self.'] },
  { category: 'languages', subcategory: 'rust', keywords: ['rust', 'cargo', 'crate', 'borrow checker', 'ownership', 'lifetime', 'trait ', 'impl ', 'enum ', 'match ', 'unwrap', 'result<', 'option<'] },
  { category: 'languages', subcategory: 'go', keywords: ['golang', ' go ', 'goroutine', 'channel', 'go mod', 'go build', 'go run', 'interface{}', 'struct ', 'defer ', 'panic ', 'recover'] },
  { category: 'languages', subcategory: 'java', keywords: ['java', 'jvm', 'maven', 'gradle', 'spring', 'junit', 'lombok', 'abstract class', 'extends ', 'implements '] },
  { category: 'languages', subcategory: 'ruby', keywords: ['ruby', 'gem ', 'bundler', 'rails', 'rake', 'rspec', 'minitest', 'attr_accessor'] },
  { category: 'languages', subcategory: 'php', keywords: ['php', 'composer', 'laravel', 'symfony', 'artisan', 'blade', 'eloquent'] },
  { category: 'languages', subcategory: 'swift', keywords: ['swift', 'xcode', 'swiftui', 'uikit', 'cocoapods', 'spm', 'optionals'] },
  { category: 'languages', subcategory: 'kotlin', keywords: ['kotlin', 'kotlinx', 'coroutine', 'suspend fun', 'data class', 'sealed class'] },

  // Frameworks
  { category: 'frameworks', subcategory: 'react', keywords: ['react', 'jsx', 'tsx', 'usestate', 'useeffect', 'usememo', 'usecallback', 'useref', 'usecontext', 'usereducer', 'component', 'props', 'hooks', 'virtual dom', 'react-dom', 'create-react-app'] },
  { category: 'frameworks', subcategory: 'nextjs', keywords: ['nextjs', 'next.js', 'next/image', 'next/link', 'next/router', 'getserversideprops', 'getstaticprops', 'getstaticpaths', 'app router', 'page router', 'server component', 'server action', 'middleware.ts'] },
  { category: 'frameworks', subcategory: 'vue', keywords: ['vue', 'vuex', 'pinia', 'nuxt', 'composition api', 'options api', 'v-model', 'v-bind', 'v-if', '<template>', '<script setup>'] },
  { category: 'frameworks', subcategory: 'angular', keywords: ['angular', 'ng ', 'ngmodule', 'component', 'directive', 'pipe', 'rxjs', 'observable', 'ngrx'] },
  { category: 'frameworks', subcategory: 'svelte', keywords: ['svelte', 'sveltekit', '$:', 'on:click', '{#if', '{#each', 'writable', 'readable'] },
  { category: 'frameworks', subcategory: 'express', keywords: ['express', 'expressjs', 'app.get', 'app.post', 'app.use', 'middleware', 'req, res', 'router'] },
  { category: 'frameworks', subcategory: 'fastify', keywords: ['fastify', 'fastify.get', 'fastify.post', 'fastify plugin'] },
  { category: 'frameworks', subcategory: 'nestjs', keywords: ['nestjs', '@injectable', '@controller', '@module', '@get', '@post', 'nest'] },
  { category: 'frameworks', subcategory: 'django', keywords: ['django', 'django rest', 'drf', 'manage.py', 'urls.py', 'views.py', 'models.py', 'migrations'] },
  { category: 'frameworks', subcategory: 'flask', keywords: ['flask', '@app.route', 'flask_restful', 'jinja2', 'werkzeug'] },
  { category: 'frameworks', subcategory: 'fastapi', keywords: ['fastapi', 'uvicorn', '@app.get', '@app.post', 'pydantic', 'depends'] },

  // Infrastructure
  { category: 'infrastructure', subcategory: 'aws', keywords: ['aws', 'amazon web services', 'ec2', 's3', 'lambda', 'cloudformation', 'cdk', 'sam', 'iam', 'vpc', 'ecs', 'eks', 'fargate', 'dynamodb', 'sqs', 'sns', 'cloudwatch', 'route53', 'api gateway', 'cognito'] },
  { category: 'infrastructure', subcategory: 'gcp', keywords: ['gcp', 'google cloud', 'cloud run', 'cloud functions', 'bigquery', 'gke', 'pubsub', 'firestore', 'cloud storage'] },
  { category: 'infrastructure', subcategory: 'azure', keywords: ['azure', 'azure functions', 'cosmos db', 'blob storage', 'app service', 'aks'] },
  { category: 'infrastructure', subcategory: 'docker', keywords: ['docker', 'dockerfile', 'docker-compose', 'container', 'docker build', 'docker run', 'docker image', 'multi-stage build'] },
  { category: 'infrastructure', subcategory: 'kubernetes', keywords: ['kubernetes', 'k8s', 'kubectl', 'pod', 'deployment', 'service', 'ingress', 'helm', 'kustomize', 'namespace', 'configmap', 'secret'] },
  { category: 'infrastructure', subcategory: 'terraform', keywords: ['terraform', 'tf', 'hcl', 'terraform plan', 'terraform apply', 'terraform state', 'provider', 'resource', 'module'] },
  { category: 'infrastructure', subcategory: 'cloudflare', keywords: ['cloudflare', 'workers', 'pages', 'r2', 'd1', 'wrangler', 'edge'] },
  { category: 'infrastructure', subcategory: 'vercel', keywords: ['vercel', 'vercel deploy', 'vercel.json', 'edge functions', 'serverless functions'] },

  // Databases
  { category: 'databases', subcategory: 'postgresql', keywords: ['postgresql', 'postgres', 'psql', 'pg_dump', 'plpgsql', 'jsonb', 'gin index', 'btree', 'vacuum', 'explain analyze', 'cte', 'window function', 'lateral join'] },
  { category: 'databases', subcategory: 'mysql', keywords: ['mysql', 'mariadb', 'innodb', 'myisam', 'mysqldump'] },
  { category: 'databases', subcategory: 'mongodb', keywords: ['mongodb', 'mongo', 'mongoose', 'aggregation pipeline', 'collection', 'document', 'bson', 'replica set'] },
  { category: 'databases', subcategory: 'redis', keywords: ['redis', 'redis-cli', 'pub/sub', 'sorted set', 'hash', 'ttl', 'expiry', 'cache invalidation'] },
  { category: 'databases', subcategory: 'sqlite', keywords: ['sqlite', 'sqlite3', 'better-sqlite3', 'wal mode'] },
  { category: 'databases', subcategory: 'elasticsearch', keywords: ['elasticsearch', 'elastic', 'kibana', 'lucene', 'opensearch', 'full-text search', 'inverted index'] },

  // Tools
  { category: 'tools', subcategory: 'git', keywords: ['git', 'git commit', 'git push', 'git pull', 'git merge', 'git rebase', 'git stash', 'branch', 'cherry-pick', 'bisect', 'gitignore', 'husky', 'pre-commit'] },
  { category: 'tools', subcategory: 'npm', keywords: ['npm', 'npm install', 'npm run', 'package.json', 'node_modules', 'npm publish', 'npm link'] },
  { category: 'tools', subcategory: 'yarn', keywords: ['yarn', 'yarn add', 'yarn workspace'] },
  { category: 'tools', subcategory: 'pnpm', keywords: ['pnpm', 'pnpm add', 'pnpm workspace'] },
  { category: 'tools', subcategory: 'webpack', keywords: ['webpack', 'webpack.config', 'loader', 'plugin', 'bundle', 'chunk', 'tree shaking', 'code splitting'] },
  { category: 'tools', subcategory: 'vite', keywords: ['vite', 'vite.config', 'vite plugin', 'hmr', 'hot module'] },
  { category: 'tools', subcategory: 'eslint', keywords: ['eslint', '.eslintrc', 'eslint-plugin', 'eslint rule', 'lint error'] },
  { category: 'tools', subcategory: 'jest', keywords: ['jest', 'describe(', 'it(', 'test(', 'expect(', 'jest.mock', 'jest.fn', 'toequal', 'tobecalledwith'] },
  { category: 'tools', subcategory: 'vitest', keywords: ['vitest', 'vitest.config'] },
  { category: 'tools', subcategory: 'playwright', keywords: ['playwright', 'page.goto', 'page.click', 'page.fill', 'locator', 'expect(page)'] },

  // Patterns
  { category: 'patterns', subcategory: 'authentication', keywords: ['authentication', 'auth', 'login', 'logout', 'jwt', 'oauth', 'oauth2', 'openid', 'session', 'cookie', 'token', 'refresh token', 'password hash', 'bcrypt', 'argon2', 'passport', 'next-auth'] },
  { category: 'patterns', subcategory: 'caching', keywords: ['cache', 'caching', 'memoize', 'memoization', 'cache invalidation', 'stale-while-revalidate', 'cache-control', 'etag', 'cdn', 'edge cache'] },
  { category: 'patterns', subcategory: 'error-handling', keywords: ['error handling', 'try catch', 'error boundary', 'retry', 'backoff', 'circuit breaker', 'fallback', 'graceful degradation', 'error recovery'] },
  { category: 'patterns', subcategory: 'testing', keywords: ['testing', 'unit test', 'integration test', 'e2e test', 'end-to-end', 'test coverage', 'mock', 'stub', 'spy', 'fixture', 'snapshot test', 'tdd', 'bdd'] },
  { category: 'patterns', subcategory: 'api-design', keywords: ['api design', 'rest api', 'graphql', 'grpc', 'openapi', 'swagger', 'endpoint', 'versioning', 'pagination', 'rate limit', 'throttle'] },
  { category: 'patterns', subcategory: 'deployment', keywords: ['deployment', 'deploy', 'ci/cd', 'continuous integration', 'continuous deployment', 'blue-green', 'canary', 'rolling update', 'zero downtime'] },
  { category: 'patterns', subcategory: 'monitoring', keywords: ['monitoring', 'observability', 'logging', 'metrics', 'tracing', 'alerting', 'dashboard', 'prometheus', 'grafana', 'datadog', 'sentry', 'opentelemetry'] },
  { category: 'patterns', subcategory: 'serverless', keywords: ['serverless', 'cold start', 'warm start', 'function-as-a-service', 'faas', 'lambda', 'cloud functions', 'edge functions'] },
  { category: 'patterns', subcategory: 'microservices', keywords: ['microservices', 'service mesh', 'api gateway', 'event-driven', 'saga', 'cqrs', 'event sourcing', 'domain-driven'] },
];

/**
 * Categorise a knowledge entry by matching keywords against summary + details.
 * Returns all matching categories sorted by confidence (highest first).
 */
export function categorise(summary: string, details: string = ''): CategoryMatch[] {
  const text = `${summary} ${details}`.toLowerCase();
  const matches: CategoryMatch[] = [];

  for (const entry of TAXONOMY) {
    let matchCount = 0;
    for (const keyword of entry.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        matchCount++;
      }
    }

    if (matchCount > 0) {
      const confidence = Math.min(matchCount / Math.max(entry.keywords.length * 0.3, 2), 1);
      matches.push({
        category: entry.category,
        subcategory: entry.subcategory,
        confidence,
      });
    }
  }

  // Sort by confidence descending
  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

/**
 * Get the best category string (e.g. "frameworks/react" or "databases/postgresql").
 * Returns "general" if no match found.
 */
export function bestCategory(summary: string, details: string = ''): string {
  const matches = categorise(summary, details);
  if (matches.length === 0) return 'general';
  return `${matches[0].category}/${matches[0].subcategory}`;
}

/**
 * Extract technology tags from text using the taxonomy keywords.
 * Returns unique subcategory names that matched.
 */
export function extractTechTags(summary: string, details: string = ''): string[] {
  const matches = categorise(summary, details);
  const tags = new Set<string>();
  for (const m of matches) {
    if (m.confidence >= 0.2) {
      tags.add(m.subcategory);
    }
  }
  return [...tags];
}
