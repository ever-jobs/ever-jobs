```markdown
# ever-jobs Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill outlines the core development patterns and conventions used in the `ever-jobs` TypeScript repository. It covers file naming, import/export styles, commit message conventions, and testing practices. The guide is intended to help contributors maintain consistency and quality across the codebase.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `jobService.ts`, `userProfile.ts`

### Import Style
- Use **relative imports** for internal modules.
  ```typescript
  import { fetchJobs } from './jobService';
  ```

### Export Style
- Use **named exports** for functions, classes, and constants.
  ```typescript
  // In jobService.ts
  export function fetchJobs() { ... }
  export const JOB_STATUS = { ... };
  ```

### Commit Messages
- Use **Conventional Commits** with the `feat` prefix for new features.
  - Example: `feat: add job filtering by location`

## Workflows

### Feature Development
**Trigger:** When adding a new feature  
**Command:** `/feature-development`

1. Create a new branch for your feature.
2. Implement the feature using camelCase file naming and relative imports.
3. Use named exports for all new modules.
4. Write or update tests in a corresponding `.spec.ts` file.
5. Commit changes with a `feat:` prefix and a clear message.
6. Open a pull request for review.

### Testing
**Trigger:** Before merging or releasing code  
**Command:** `/run-tests`

1. Ensure all `.spec.ts` files are up-to-date.
2. Run tests using Jest:
   ```bash
   npx jest
   ```
3. Check that all tests pass before proceeding.

## Testing Patterns

- Tests are written using **Jest**.
- Test files follow the pattern: `*.spec.ts`.
- Place test files alongside the modules they test or in a dedicated `__tests__` directory.
- Example test file:
  ```typescript
  // jobService.spec.ts
  import { fetchJobs } from './jobService';

  describe('fetchJobs', () => {
    it('returns a list of jobs', () => {
      const jobs = fetchJobs();
      expect(Array.isArray(jobs)).toBe(true);
    });
  });
  ```

## Commands
| Command              | Purpose                                 |
|----------------------|-----------------------------------------|
| /feature-development | Start the feature development workflow  |
| /run-tests           | Run all Jest tests                      |
```
