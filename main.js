const express = require('express');
const client = require('prom-client');
const YAML = require('yamljs');
const fs = require('fs');
const path = require('path');

const app = express();

// Determine the environment and load the corresponding .env file
const env = process.env.NODE_ENV || 'development'; // Default to development
const envFilePath = path.resolve(__dirname, `.env.${env}`);
require('dotenv').config({ path: envFilePath });

// Load from environment variables
const port = process.env.REST_COUNTERS_PORT || 3000;
const host = process.env.REST_COUNTERS_HOST || 'localhost';
const apiToken = process.env.REST_COUNTERS_TOKEN;
const configPath = process.env.REST_COUNTERS_CONFIG || 'config.yaml'; // Default to 'config.yaml' if not set

// Load the YAML configuration
let config;
try {
  config = YAML.load(configPath);
  console.log(`Loaded configuration from ${configPath}`);
} catch (error) {
  console.error(`Failed to load configuration from ${configPath}:`, error.message);
  process.exit(1);
}

// Create counters based on YAML configuration and map rate limits
const counters = {};
const rateLimits = {};

config.counters.forEach(counterConfig => {
  const { name, help, labels, rate_limit } = counterConfig;
  counters[name] = new client.Counter({
    name: name,
    help: help,
    labelNames: labels || []
  });

  if (rate_limit) {
    rateLimits[name] = rate_limit; // Store rate limit per counter
  }
});

// Middleware for token authorization and rate limiting per counter
const clientRequestTimestamps = {};

const authorizeAndRateLimit = (req, res, next) => {
  const token = req.headers['authorization'];
  const clientId = req.headers['x-client-id'];
  const counterName = req.params.counterName;

  if (!token || token !== `Bearer ${apiToken}`) {
    return res.status(401).send('Unauthorized: Invalid or missing token');
  }

  if (!clientId) {
    return res.status(400).send('Client ID missing');
  }

  if (!counters[counterName]) {
    return res.status(400).send('Invalid counter name');
  }

  if (!rateLimits[counterName]) {
    next();
  }

  const currentTime = Date.now();
  const lastRequestTime = clientRequestTimestamps[`${clientId}-${counterName}`];
  const rateLimitInterval = rateLimits[counterName];

  if (lastRequestTime && currentTime - lastRequestTime < rateLimitInterval) {
    return res.status(429).send('Rate limit exceeded. Please try again later.');
  }

  // Update timestamp for this client ID and counter
  clientRequestTimestamps[`${clientId}-${counterName}`] = currentTime;
  next();
};

// Protected route with per-counter rate limiting
app.post('/track/:counterName', authorizeAndRateLimit, (req, res) => {
  const counterName = req.params.counterName;
  const counter = counters[counterName];

  if (counter) {
    const labels = req.query || {};
    counter.inc(labels, 1);
    console.log(`Counter ${counterName} with labels ${JSON.stringify(labels)} incremented.`);
    res.status(200).send(`Counter ${counterName} incremented.`);
  } else {
    console.log(`Counter ${counterName} not found.`);
    res.status(404).send('Counter not found.');
  }
});

// Expose metrics endpoint for Prometheus
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(port, () => {
  console.log(`Metrics server running at http://${host}:${port}/`);
});
