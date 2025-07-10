
const { chromium, firefox, webkit } = require("playwright");
const fs = require('fs').promises;
const path = require('path');



class HackerNewsScraper {
  constructor(options = {}) {
    this.options = {
      targetArticles: options.targetArticles || 100,
      browsers: options.browsers || ['chromium'],
      outputDir: options.outputDir || './reports',
      enableScreenshots: options.enableScreenshots || true,
      enablePerformanceMonitoring: options.enablePerformanceMonitoring || true,
      maxConsecutiveErrors: options.maxConsecutiveErrors || 5,
      pageTimeout: options.pageTimeout || 45000,
      navigationTimeout: options.navigationTimeout || 60000,
      ...options
    };

    this.results = {
      testRuns: [],
      summary: null,
      startTime: null,
      endTime: null
    };
  }

 
  log(level, message, metadata = {}) {
    const logEntry = {
      level,
      timestamp: new Date().toISOString(),
      message,
      metadata
    };

    const colorMap = {
      'INFO': '\x1b[36m',    // Cyan
      'WARN': '\x1b[33m',    // Yellow
      'ERROR': '\x1b[31m',   // Red
      'SUCCESS': '\x1b[32m', // Green
      'RESET': '\x1b[0m'     // Reset
    };

    const color = colorMap[level] || colorMap['INFO'];
    console.log(`${color}[${level}]${colorMap['RESET']} ${message}`,
      metadata && Object.keys(metadata).length > 0 ? metadata : '');
  }

 
  async initializeReporting() {
    try {
      await fs.mkdir(this.options.outputDir, { recursive: true });
      await fs.mkdir(path.join(this.options.outputDir, 'screenshots'), { recursive: true });
      this.log('INFO', 'Reporting directories initialized');
    } catch (error) {
      this.log('ERROR', 'Failed to initialize reporting directories', { error: error.message });
    }
  }

 
  async safeNavigateToNext(page, currentPage) {
    try {
      if (page.isClosed()) {
        throw new Error('Page is closed');
      }

      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
      });

      const moreLink = await page.$('a.morelink');
      if (!moreLink) {
        this.log('INFO', 'No more pages available');
        return false;
      }

      const href = await moreLink.getAttribute('href');
      if (!href) {
        this.log('WARN', 'More link has no href attribute');
        return false;
      }

      this.log('INFO', `Navigating to page ${currentPage + 1}`, { href });

      await page.waitForTimeout(2000);

      try {
        const baseUrl = 'https://news.ycombinator.com';
        const fullUrl = href.startsWith('http') ? href : `${baseUrl}/${href}`;

        await page.goto(fullUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.options.navigationTimeout
        });

      } catch (gotoError) {
        this.log('WARN', 'Direct navigation failed, trying click method', { error: gotoError.message });

        const currentUrl = page.url();
        await moreLink.click();

        await page.waitForFunction(
          (oldUrl) => window.location.href !== oldUrl,
          currentUrl,
          { timeout: this.options.navigationTimeout }
        );

        await page.waitForLoadState('domcontentloaded', { timeout: this.options.pageTimeout });
      }

      await this.waitForArticles(page);

      this.log('INFO', `Successfully navigated to page ${currentPage + 1}`);
      return true;

    } catch (error) {
      this.log('ERROR', 'Navigation failed', {
        error: error.message,
        page: currentPage + 1,
        isClosed: page.isClosed()
      });
      return false;
    }
  }


  async waitForArticles(page) {
    try {
      await page.waitForSelector('tr.athing', { timeout: 20000 });

      // Verify we actually have articles
      const articleCount = await page.$$eval('tr.athing', rows => rows.length);
      if (articleCount === 0) {
        throw new Error('No articles found after selector wait');
      }

      this.log('INFO', `Found ${articleCount} articles on page`);

    } catch (selectorError) {
      this.log('WARN', 'Primary selector wait failed, trying fallback methods');

      // Fallback 1: Wait for network idle
      try {
        await page.waitForLoadState('networkidle', { timeout: 15000 });

        const articleCount = await page.$$eval('tr.athing', rows => rows.length);
        if (articleCount > 0) {
          this.log('INFO', `Fallback successful: found ${articleCount} articles`);
          return;
        }
      } catch (networkError) {
        this.log('WARN', 'Network idle wait failed');
      }

      // Fallback 2: Wait for any table content
      try {
        await page.waitForSelector('table', { timeout: 10000 });
        const articleCount = await page.$$eval('tr.athing', rows => rows.length);
        if (articleCount > 0) {
          this.log('INFO', `Table fallback successful: found ${articleCount} articles`);
          return;
        }
      } catch (tableError) {
        this.log('WARN', 'Table fallback failed');
      }

      // Final check
      const finalCount = await page.$$eval('tr.athing', rows => rows.length);
      if (finalCount === 0) {
        throw new Error('No articles found after all fallback attempts');
      }

      this.log('INFO', `Final check found ${finalCount} articles`);
    }
  }

 
  async scrapeArticlesWithBrowser(browserType) {
    const performanceMetrics = {
      browserType,
      startTime: Date.now(),
      pageLoadTimes: [],
      articleProcessingTimes: [],
      networkRequests: 0,
      errors: []
    };

    let browser = null;
    let page = null;

    try {
      // Launch browser based on type
      const browsers = { chromium, firefox, webkit };
      browser = await browsers[browserType].launch({
        headless: true,
        timeout: 60000,
        // Add browser-specific options
        args: browserType === 'chromium' ? [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-extensions'
        ] : []
      });

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        // Add extra headers to appear more like a real browser
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        }
      });

      page = await context.newPage();

      // Monitor network requests
      page.on('request', () => performanceMetrics.networkRequests++);

      // Set timeouts
      page.setDefaultTimeout(this.options.pageTimeout);
      page.setDefaultNavigationTimeout(this.options.navigationTimeout);

      this.log('INFO', `Starting scrape with ${browserType}`, {
        targetArticles: this.options.targetArticles
      });

      // Initial navigation
      const navigationStart = Date.now();
      await page.goto("https://news.ycombinator.com/newest", {
        waitUntil: 'domcontentloaded',
        timeout: this.options.navigationTimeout
      });
      performanceMetrics.pageLoadTimes.push(Date.now() - navigationStart);

      // Wait for initial articles
      await this.waitForArticles(page);

      const articles = [];
      let currentPage = 1;
      let consecutiveErrors = 0;
      let maxPages = 10; // Prevent infinite loops

      while (articles.length < this.options.targetArticles &&
        consecutiveErrors < this.options.maxConsecutiveErrors &&
        currentPage <= maxPages) {

        const pageProcessingStart = Date.now();
        this.log('INFO', `Processing page ${currentPage}`, {
          articlesCollected: articles.length,
          browser: browserType,
          consecutiveErrors
        });

        try {
          // Ensure page is still responsive
          if (page.isClosed()) {
            throw new Error('Page was closed unexpectedly');
          }

          // Wait for content to be ready
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 });

          const articleRows = await page.$$('tr.athing');
          this.log('INFO', `Found ${articleRows.length} articles on page ${currentPage}`);

          if (articleRows.length === 0) {
            this.log('WARN', 'No articles found on page', { page: currentPage });
            consecutiveErrors++;

            // Try to refresh the page
            if (consecutiveErrors < 3) {
              this.log('INFO', 'Attempting to refresh page');
              await page.reload({ waitUntil: 'domcontentloaded' });
              await this.waitForArticles(page);
              continue;
            } else {
              break;
            }
          }

          // Take screenshot of current page
          if (this.options.enableScreenshots) {
            try {
              await page.screenshot({
                path: path.join(this.options.outputDir, 'screenshots', `page-${currentPage}-${browserType}.png`),
                fullPage: false
              });
            } catch (screenshotError) {
              this.log('WARN', 'Screenshot failed', { error: screenshotError.message });
            }
          }

          // Process articles on current page
          let pageArticlesProcessed = 0;
          for (const row of articleRows) {
            if (articles.length >= this.options.targetArticles) break;

            const articleStart = Date.now();
            try {
              const subtextRow = await row.evaluateHandle(node => node.nextElementSibling);

              if (!subtextRow) {
                this.log('WARN', 'No subtext row found for article');
                continue;
              }

              const timestamp = await subtextRow.evaluate(node => {
                return node.querySelector('.age')?.title ||
                  node.querySelector('.age a')?.title ||
                  node.querySelector('[title]')?.title ||
                  null;
              });

              let finalTimestamp = timestamp;

              if (!timestamp) {
                const timeText = await subtextRow.evaluate(node => {
                  return node.querySelector('.age')?.textContent?.trim() ||
                    node.querySelector('.age a')?.textContent?.trim() ||
                    null;
                });

                if (timeText) {
                  finalTimestamp = timeText;
                } else {
                  this.log('WARN', 'Skipping article - no timestamp found');
                  continue;
                }
              }

              const title = await row.evaluate(node => {
                return node.querySelector('.titleline a')?.textContent?.trim() ||
                  node.querySelector('a.storylink')?.textContent?.trim() ||
                  'No title';
              });

              if (title === 'No title') {
                this.log('WARN', 'Skipping article - no title found');
                continue;
              }

              articles.push({
                title,
                timestamp: finalTimestamp,
                position: articles.length + 1,
                page: currentPage,
                browser: browserType,
                processingTime: Date.now() - articleStart
              });

              pageArticlesProcessed++;
              performanceMetrics.articleProcessingTimes.push(Date.now() - articleStart);

              if (articles.length % 10 === 0) {
                this.log('INFO', `Progress: ${articles.length}/${this.options.targetArticles} articles`);
              }

            } catch (error) {
              this.log('WARN', 'Error processing article', {
                error: error.message,
                page: currentPage,
                articleIndex: pageArticlesProcessed
              });
              performanceMetrics.errors.push({
                type: 'article_processing',
                message: error.message,
                page: currentPage
              });
            }
          }

          this.log('INFO', `Processed ${pageArticlesProcessed} articles on page ${currentPage}`);
          consecutiveErrors = 0;
          performanceMetrics.pageLoadTimes.push(Date.now() - pageProcessingStart);

        } catch (error) {
          this.log('ERROR', `Error processing page ${currentPage}`, { error: error.message });
          performanceMetrics.errors.push({
            type: 'page_processing',
            message: error.message,
            page: currentPage
          });
          consecutiveErrors++;

          // Try to recover by reloading the page
          if (consecutiveErrors < 3 && !page.isClosed()) {
            try {
              this.log('INFO', 'Attempting page recovery');
              await page.reload({ waitUntil: 'domcontentloaded' });
              await this.waitForArticles(page);
              continue;
            } catch (recoveryError) {
              this.log('ERROR', 'Page recovery failed', { error: recoveryError.message });
            }
          }
        }

        // Navigate to next page if needed
        if (articles.length < this.options.targetArticles && currentPage < maxPages) {
          const navigationSuccess = await this.safeNavigateToNext(page, currentPage);
          if (navigationSuccess) {
            currentPage++;
          } else {
            this.log('WARN', 'Failed to navigate to next page, stopping');
            break;
          }
        }
      }

      // Calculate performance metrics
      performanceMetrics.endTime = Date.now();
      performanceMetrics.totalTime = performanceMetrics.endTime - performanceMetrics.startTime;
      performanceMetrics.averagePageLoadTime = performanceMetrics.pageLoadTimes.length > 0
        ? performanceMetrics.pageLoadTimes.reduce((a, b) => a + b, 0) / performanceMetrics.pageLoadTimes.length
        : 0;
      performanceMetrics.averageArticleProcessingTime = performanceMetrics.articleProcessingTimes.length > 0
        ? performanceMetrics.articleProcessingTimes.reduce((a, b) => a + b, 0) / performanceMetrics.articleProcessingTimes.length
        : 0;

      // Validate sorting
      const sortingErrors = this.validateSorting(articles);

      const testResult = {
        browser: browserType,
        success: sortingErrors.length === 0,
        articlesCollected: articles.length,
        sortingErrors,
        performanceMetrics,
        articles: articles.slice(0, 10), // Include first 10 articles in results
        timestamp: new Date().toISOString()
      };

      this.log(sortingErrors.length === 0 ? 'SUCCESS' : 'ERROR',
        `${browserType} validation ${sortingErrors.length === 0 ? 'PASSED' : 'FAILED'}`,
        {
          articlesCollected: articles.length,
          sortingErrors: sortingErrors.length,
          totalTime: `${performanceMetrics.totalTime}ms`,
          pagesProcessed: currentPage
        });

      return testResult;

    } catch (error) {
      this.log('ERROR', `Critical error in ${browserType}`, {
        error: error.message,
        stack: error.stack
      });
      return {
        browser: browserType,
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    } finally {
      // Cleanup with proper error handling
      try {
        if (page && !page.isClosed()) {
          await page.close();
        }
      } catch (pageCloseError) {
        this.log('WARN', 'Error closing page', { error: pageCloseError.message });
      }

      try {
        if (browser) {
          await browser.close();
        }
      } catch (browserCloseError) {
        this.log('WARN', 'Error closing browser', { error: browserCloseError.message });
      }
    }
  }


  validateSorting(articles) {
    const sortingErrors = [];

    for (let i = 0; i < articles.length - 1; i++) {
      // For proper date comparison, we need to handle different timestamp formats
      const current = this.parseTimestamp(articles[i].timestamp);
      const next = this.parseTimestamp(articles[i + 1].timestamp);

      if (current && next && current < next) {
        sortingErrors.push({
          position: i + 1,
          current: articles[i],
          next: articles[i + 1]
        });
      }
    }

    return sortingErrors;
  }

  
  parseTimestamp(timestamp) {
    try {
      // Handle ISO format
      if (timestamp.includes('T')) {
        return new Date(timestamp);
      }

      // Handle relative timestamps like "2 hours ago"
      const now = new Date();
      const timeMatch = timestamp.match(/(\d+)\s*(minute|hour|day)s?\s*ago/);
      if (timeMatch) {
        const value = parseInt(timeMatch[1]);
        const unit = timeMatch[2];

        switch (unit) {
          case 'minute':
            return new Date(now.getTime() - value * 60 * 1000);
          case 'hour':
            return new Date(now.getTime() - value * 60 * 60 * 1000);
          case 'day':
            return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
        }
      }

      // Fallback to direct parsing
      return new Date(timestamp);
    } catch (error) {
      return null;
    }
  }


  async runAllTests() {
    this.results.startTime = new Date().toISOString();
    this.log('INFO', 'Starting comprehensive validation across all browsers', {
      browsers: this.options.browsers,
      targetArticles: this.options.targetArticles
    });

    await this.initializeReporting();

    for (const browserType of this.options.browsers) {
      this.log('INFO', `Testing with ${browserType}`);
      const result = await this.scrapeArticlesWithBrowser(browserType);
      this.results.testRuns.push(result);
    }

    this.results.endTime = new Date().toISOString();
    this.results.summary = this.generateSummary();

    // Generate reports
    await this.generateTextReport();
    await this.generateHTMLReport();
    await this.generateJSONReport();

    this.log('SUCCESS', 'All tests completed successfully', {
      totalRuns: this.results.testRuns.length,
      successful: this.results.testRuns.filter(r => r.success).length,
      failed: this.results.testRuns.filter(r => !r.success).length
    });

    return this.results;
  }

  /**
   * Generate summary statistics
   */
  generateSummary() {
    const successfulRuns = this.results.testRuns.filter(r => r.success);
    const failedRuns = this.results.testRuns.filter(r => !r.success);

    return {
      totalRuns: this.results.testRuns.length,
      successful: successfulRuns.length,
      failed: failedRuns.length,
      successRate: this.results.testRuns.length > 0 ? (successfulRuns.length / this.results.testRuns.length) * 100 : 0,
      browsers: this.results.testRuns.map(r => r.browser),
      averageArticlesCollected: this.results.testRuns.length > 0 ?
        this.results.testRuns.reduce((sum, r) => sum + (r.articlesCollected || 0), 0) / this.results.testRuns.length : 0,
      totalSortingErrors: this.results.testRuns.reduce((sum, r) => sum + (r.sortingErrors?.length || 0), 0)
    };
  }


  async generateTextReport() {
    const report = [
      '='.repeat(80),
      'HACKER NEWS SORTING VALIDATION REPORT',
      '='.repeat(80),
      `Generated: ${new Date().toISOString()}`,
      `Test Duration: ${this.results.startTime} to ${this.results.endTime}`,
      '',
      'SUMMARY',
      '-'.repeat(40),
      `Total Test Runs: ${this.results.summary.totalRuns}`,
      `Successful: ${this.results.summary.successful}`,
      `Failed: ${this.results.summary.failed}`,
      `Success Rate: ${this.results.summary.successRate.toFixed(2)}%`,
      `Average Articles Collected: ${this.results.summary.averageArticlesCollected.toFixed(0)}`,
      `Total Sorting Errors: ${this.results.summary.totalSortingErrors}`,
      '',
      'DETAILED RESULTS',
      '-'.repeat(40)
    ];

    this.results.testRuns.forEach(run => {
      report.push(`\n${run.browser.toUpperCase()} BROWSER:`);
      report.push(`  Status: ${run.success ? '✅ PASSED' : '❌ FAILED'}`);
      report.push(`  Articles Collected: ${run.articlesCollected || 0}`);
      report.push(`  Sorting Errors: ${run.sortingErrors?.length || 0}`);

      if (run.performanceMetrics) {
        report.push(`  Total Time: ${run.performanceMetrics.totalTime}ms`);
        report.push(`  Average Page Load: ${run.performanceMetrics.averagePageLoadTime?.toFixed(2)}ms`);
        report.push(`  Network Requests: ${run.performanceMetrics.networkRequests}`);
      }

      if (run.error) {
        report.push(`  Error: ${run.error}`);
      }

      if (run.sortingErrors && run.sortingErrors.length > 0) {
        report.push(`  First Sorting Error:`);
        const error = run.sortingErrors[0];
        report.push(`    Position: ${error.position}`);
        report.push(`    Current: ${error.current.title}`);
        report.push(`    Next: ${error.next.title}`);
      }
    });

    const reportPath = path.join(this.options.outputDir, 'validation-report.txt');
    await fs.writeFile(reportPath, report.join('\n'));
    this.log('INFO', 'Text report generated', { path: reportPath });
  }



  async generateHTMLReport() {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hacker News Validation Report</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #ff6600; text-align: center; margin-bottom: 30px; }
        .summary { background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px; }
        .metric { display: inline-block; margin: 10px 20px; text-align: center; }
        .metric-value { font-size: 2em; font-weight: bold; color: #333; }
        .metric-label { font-size: 0.9em; color: #666; }
        .success { color: #28a745; }
        .failure { color: #dc3545; }
        .browser-result { border: 1px solid #ddd; margin: 20px 0; padding: 20px; border-radius: 8px; }
        .browser-result.success { border-left: 5px solid #28a745; }
        .browser-result.failure { border-left: 5px solid #dc3545; }
        .performance-chart { margin: 20px 0; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #ddd; }
        th { background: #f8f9fa; font-weight: 600; }
        .timestamp { font-size: 0.9em; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍 Hacker News Sorting Validation Report</h1>
        
        <div class="summary">
            <div class="metric">
                <div class="metric-value ${this.results.summary.successRate === 100 ? 'success' : 'failure'}">
                    ${this.results.summary.successRate.toFixed(1)}%
                </div>
                <div class="metric-label">Success Rate</div>
            </div>
            <div class="metric">
                <div class="metric-value">${this.results.summary.totalRuns}</div>
                <div class="metric-label">Total Tests</div>
            </div>
            <div class="metric">
                <div class="metric-value">${this.results.summary.averageArticlesCollected.toFixed(0)}</div>
                <div class="metric-label">Avg Articles</div>
            </div>
            <div class="metric">
                <div class="metric-value ${this.results.summary.totalSortingErrors === 0 ? 'success' : 'failure'}">
                    ${this.results.summary.totalSortingErrors}
                </div>
                <div class="metric-label">Sorting Errors</div>
            </div>
        </div>
        
        <h2>Test Results by Browser</h2>
        ${this.results.testRuns.map(run => `
            <div class="browser-result ${run.success ? 'success' : 'failure'}">
                <h3>${run.browser.toUpperCase()} Browser</h3>
                <p><strong>Status:</strong> <span class="${run.success ? 'success' : 'failure'}">${run.success ? '✅ PASSED' : '❌ FAILED'}</span></p>
                <p><strong>Articles Collected:</strong> ${run.articlesCollected || 0}</p>
                <p><strong>Sorting Errors:</strong> ${run.sortingErrors?.length || 0}</p>
                
                ${run.performanceMetrics ? `
                    <h4>Performance Metrics</h4>
                    <ul>
                        <li>Total Execution Time: ${run.performanceMetrics.totalTime}ms</li>
                        <li>Average Page Load Time: ${run.performanceMetrics.averagePageLoadTime?.toFixed(2)}ms</li>
                        <li>Network Requests: ${run.performanceMetrics.networkRequests}</li>
                        <li>Processing Errors: ${run.performanceMetrics.errors.length}</li>
                    </ul>
                ` : ''}
                
                ${run.sortingErrors && run.sortingErrors.length > 0 ? `
                    <h4>Sorting Errors</h4>
                    <table>
                        <thead>
                            <tr><th>Position</th><th>Current Article</th><th>Next Article</th></tr>
                        </thead>
                        <tbody>
                            ${run.sortingErrors.slice(0, 5).map(error => `
                                <tr>
                                    <td>${error.position}</td>
                                    <td>${error.current.title}</td>
                                    <td>${error.next.title}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                ` : ''}
            </div>
        `).join('')}
        
        <div class="timestamp">
            Report generated on ${new Date().toLocaleString()}
        </div>
    </div>
</body>
</html>`;

    const reportPath = path.join(this.options.outputDir, 'validation-report.html');
    await fs.writeFile(reportPath, html);
    this.log('INFO', 'HTML report generated', { path: reportPath });
  }


  async generateJSONReport() {
    const reportPath = path.join(this.options.outputDir, 'validation-report.json');
    await fs.writeFile(reportPath, JSON.stringify(this.results, null, 2));
    this.log('INFO', 'JSON report generated', { path: reportPath });
  }
}


async function main() {
  const scraper = new HackerNewsScraper({
    targetArticles: 100,
    browsers: ['chromium'], // Add 'firefox', 'webkit' for multi-browser testing
    enableScreenshots: true,
    enablePerformanceMonitoring: true,
    outputDir: './reports'
  });

  try {
    const results = await scraper.runAllTests();

    // Console summary
    console.log('\n' + '='.repeat(80));
    console.log('FINAL RESULTS SUMMARY');
    console.log('='.repeat(80));
    console.log(`✅ Success Rate: ${results.summary.successRate.toFixed(1)}%`);
    console.log(`📊 Total Tests: ${results.summary.totalRuns}`);
    console.log(`🎯 Average Articles: ${results.summary.averageArticlesCollected.toFixed(0)}`);
    console.log(`❌ Total Sorting Errors: ${results.summary.totalSortingErrors}`);
    console.log(`📁 Reports saved to: ./reports/`);

    // Exit with appropriate code
    process.exit(results.summary.totalSortingErrors === 0 ? 0 : 1);

  } catch (error) {
    console.error('❌ CRITICAL ERROR:', error.message);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = { HackerNewsScraper };
