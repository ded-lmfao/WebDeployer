# Project: Nexus Deploy 2.0 — Self-Hosted Deployment Platform

Act as a senior DevOps engineer, backend architect, and full-stack developer.

I want to build a production-ready, self-hosted deployment management platform that runs on my own Linux VM.

The application should automatically connect to GitHub repositories, fetch new commits, pull updates, build applications, deploy them directly to my VM, monitor their health, and allow instant rollback to previous working deployments.

The goal is to make deployments as simple as clicking one button, while also supporting completely automatic deployments.

## 1. Core functionality

Build a complete deployment dashboard with these sections:

- Overview
- Projects
- GitHub
- Deployments
- Releases
- Rollbacks
- Logs
- Environment Variables
- Backups
- Server Monitoring
- Settings
- Activity / Audit Logs

Use a modern, dark-themed, professional UI. Keep the existing Nexus Deploy visual identity and design language.

## 2. GitHub integration

Implement complete GitHub integration.

Features:

- Connect GitHub using GitHub App or secure OAuth integration.
- Support private and public repositories.
- Select repository and deployment branch.
- Fetch commits automatically every 1–5 minutes (configurable).
- Support GitHub webhooks for instant notifications.
- Display latest commits, commit messages, authors and timestamps.
- Display how many commits are ahead or behind the deployed version.
- Fetch must never automatically deploy.
- Provide separate Fetch, Pull and Deploy actions.
- Allow manual deployment of any previous commit.
- Prevent duplicate deployments of the same commit.
- Support multiple repositories and projects.

## 3. Automated deployment engine

This is the most important component.

Implement this deployment pipeline:

1. Receive a GitHub webhook or scheduled update.
2. Verify the webhook signature.
3. Identify the project and target branch.
4. Fetch the latest GitHub changes.
5. Detect new commits.
6. Download or pull the exact commit SHA.
7. Create a new isolated release directory.
8. Install dependencies.
9. Run the configured build commands.
10. Run pre-deployment checks.
11. Deploy the new release.
12. Restart or reload the application.
13. Perform HTTP or custom health checks.
14. Mark deployment successful only after health checks pass.
15. Record all deployment details.

Never deploy directly inside the currently running application directory.

Use versioned release directories and an atomic current-release symlink or equivalent deployment mechanism.

Support:
- Node.js applications
- React / Vite applications
- Express applications
- Next.js applications
- Python applications
- Docker applications
- Docker Compose applications
- Custom build and start commands

Automatically detect the project type where possible, but allow manual configuration.

## 4. Automatic rollback system

Implement a proper rollback engine.

Requirements:

- Save every successful deployment as an immutable release.
- Maintain deployment history.
- Keep the last 10–20 successful releases (configurable).
- Every release must store its commit SHA, build information, deployment time and status.
- Add a Rollback button beside every previous successful release.
- Allow rollback to any retained release.
- Rollback must restore the previous working application version.
- Preserve environment variables and application configuration.
- Restart the application after rollback.
- Perform health checks after rollback.
- Display rollback status and logs.

### Automatic rollback

If any of these happen during deployment:

- Dependency installation fails.
- Build fails.
- Application fails to start.
- Health check fails.
- Application crashes immediately after deployment.

Automatically restore the previous successful release.

Never mark a failed deployment as successful.

Never remove the last known working release.

## 5. Deployment configuration

Every project should have its own configuration:

- GitHub repository.
- Branch.
- VM deployment directory.
- Build command.
- Install command.
- Start command.
- Application port.
- Health-check URL.
- Deployment method.
- Restart strategy.
- Environment variables.
- Release retention count.
- Automatic deployment enabled/disabled.

Support both automatic and manual deployment modes.

## 6. Environment variables and secrets

Build a secure environment variable manager.

Features:

- Add, edit and delete environment variables.
- Mask sensitive values by default.
- Reveal values only after authentication.
- Never display secrets in logs.
- Never expose environment variables through frontend APIs unnecessarily.
- Store secrets securely with restricted filesystem permissions.
- Support project-specific environment configurations.
- Preserve existing environment variables during deployments.
- Provide backup and restore functionality for configuration.

## 7. Logs and monitoring

Build a real-time log viewer.

Separate logs into:

- Deployment logs.
- Build logs.
- Application logs.
- System logs.
- Rollback logs.
- GitHub synchronization logs.

Provide:
- Live log streaming.
- Search and filtering.
- Error highlighting.
- Download logs.
- Deployment-specific logs.
- Timestamps.
- Clear failure reasons.

Server monitoring should display:

- CPU usage.
- RAM usage.
- Disk usage.
- Available disk space.
- Application status.
- Application uptime.
- Deployment status.
- Last successful deployment.

## 8. Backup system

Before every deployment:

- Optionally create an application backup.
- Back up configuration and environment files.
- Support user-configured database backup commands.
- Preserve uploaded files and persistent application data.
- Provide manual backup and restore options.

Never overwrite persistent user data during deployment.

## 9. Deployment dashboard

The overview page should display:

- Overall server health.
- Connected GitHub repository.
- Current deployed commit.
- Latest available GitHub commit.
- Number of commits behind/ahead.
- Application container or process status.
- Current deployment version.
- Last successful deployment.
- Disk space.
- CPU and memory usage.

Add quick actions:

- Check GitHub
- Fetch Updates
- Pull Updates
- Deploy Latest
- Restart Application
- Back Up Data
- Open Application

Display recent deployment operations with success, failed, running and rolled-back statuses.

## 10. Releases interface

Create a dedicated Releases page.

Each release should display:

- Commit SHA.
- Commit message.
- Author.
- Deployment date.
- Deployment duration.
- Release status.
- Build status.
- Health-check status.

Actions:

- View Details
- Deploy
- Rollback
- View Logs

Clearly identify the currently live release.

## 11. Deployment safety and reliability

This is critical.

Implement:

- Deployment locking to prevent concurrent deployments.
- Atomic release switching.
- Automatic rollback on failure.
- GitHub webhook signature verification.
- SSH key-based GitHub access or GitHub App authentication.
- Strict command execution validation.
- No arbitrary shell execution through unauthenticated API endpoints.
- Rate limiting.
- CSRF protection where applicable.
- Authentication and role-based authorization.
- Audit logs for sensitive operations.
- Secure session management.
- Graceful application restarts.
- Deployment timeouts.
- Disk-space checks before deployment.
- Automatic cleanup of old releases without deleting active or rollback-critical versions.

Never expose the VM's SSH credentials, GitHub tokens or application secrets to the browser.

## 12. Architecture

Design this as a modular application.

Separate:

- Frontend dashboard.
- Backend API.
- GitHub integration service.
- Deployment worker.
- Rollback manager.
- Monitoring service.
- Backup service.
- Log streaming service.

Deployment tasks should run in a background worker rather than blocking API requests.

Use a persistent job queue so deployments survive backend restarts.

Make all deployment operations recoverable and idempotent.

## 13. User experience

The interface must be simple enough that I do not need to SSH into my VM for routine deployments.

I should be able to:

1. Open Nexus Deploy.
2. See whether GitHub has new commits.
3. Click Deploy Latest or enable automatic deployment.
4. Watch real-time deployment progress.
5. See whether deployment succeeded.
6. Roll back with one click if necessary.

Show clear deployment stages:

Pending → Fetching → Pulling → Installing → Building → Deploying → Health Checking → Success / Failed / Rolled Back.

Do not use fake progress indicators. Display actual job status from the backend.

## 14. Development requirements

Before modifying anything:

- Inspect my existing codebase.
- Understand the existing architecture.
- Identify the existing GitHub integration.
- Identify the deployment mechanism.
- Preserve all existing functionality.
- Reuse existing components and services wherever appropriate.
- Avoid unnecessary rewrites.
- Do not introduce duplicate deployment engines.

Implement features incrementally with proper error handling and logging.

Provide database migrations where needed.

Write setup documentation, VM installation instructions, environment variable documentation and recovery procedures.

## 15. Final acceptance criteria

The system is not complete until I can demonstrate the following:

1. Push a new commit to GitHub.
2. Nexus Deploy detects the commit automatically.
3. The deployment worker fetches the changes.
4. The application builds and deploys to my VM.
5. The new release becomes live without unnecessary downtime.
6. If the build fails, the old version remains live.
7. If the application fails its health check, automatic rollback occurs.
8. I can manually roll back to any retained successful release.
9. All deployment logs are accessible from the dashboard.
10. Environment variables and persistent data remain intact.

**Important:** Do not just create UI components or mock functionality. Implement the actual backend deployment engine and connect every dashboard action to real functionality.

The final product must be production-ready, secure, reliable and usable on my own Linux VM.
# CRITICAL FEATURE: MULTI-WEBSITE MANAGEMENT

Nexus Deploy must support managing multiple independent websites and applications from one central dashboard on a single Linux VM.

This is not a single-project deployment system.

It must function as a lightweight self-hosted alternative to platforms like Coolify, CapRover and Railway.

## 1. Multiple project management

Allow unlimited projects, subject to available server resources.

Each project must have independent:

- Project name.
- GitHub repository.
- Git branch.
- Domain names and subdomains.
- Deployment directory.
- Application port.
- Build configuration.
- Start command.
- Environment variables.
- Deployment history.
- Release history.
- Rollback history.
- Application logs.
- Health monitoring.
- Backup configuration.

Projects must be completely isolated from each other.

Deploying one website must never affect another website.

## 2. Add Website workflow

Create an Add New Website button.

The user should be able to:

1. Enter project name.
2. Connect or select a GitHub repository.
3. Select a branch.
4. Enter one or more domains.
5. Select application type.
6. Configure build and start commands.
7. Configure environment variables.
8. Select deployment method.
9. Configure health-check URL.
10. Click Create Project.

Automatically provision the necessary application directories, deployment configuration and reverse proxy configuration.

## 3. Domain management

Support:

- Multiple domains per website.
- Subdomains.
- Custom domains.
- Domain reassignment.
- Domain removal.
- HTTP to HTTPS redirection.
- Automatic SSL certificate provisioning and renewal using Let's Encrypt.
- Nginx reverse proxy configuration.

For example:

website-a.com → Application A → Port 3001

website-b.com → Application B → Port 3002

api.example.com → Application C → Port 3003

dashboard.example.com → Application D → Port 3004

Automatically configure Nginx virtual hosts and reload Nginx safely after validating configuration.

Never break existing domains when adding another website.

## 4. Independent deployment engine

Every website must have its own deployment lifecycle.

When GitHub detects a new commit:

- Identify the associated project.
- Fetch that repository.
- Build the new release independently.
- Deploy only that project.
- Run its health checks.
- Automatically rollback that project if deployment fails.

Multiple websites should be deployable simultaneously, with configurable concurrency limits.

A deployment failure on Website A must never restart or rollback Website B.

## 5. Independent application processes

Support different applications running simultaneously.

Preferred options:

- Docker containers.
- Docker Compose.
- PM2.
- systemd services.

Each project must have independent:

- Process ID or container ID.
- Application port.
- Restart policy.
- Resource monitoring.
- Application logs.
- Start/stop/restart controls.

Prevent port conflicts automatically.

## 6. Multi-website dashboard

Create a Projects page showing all hosted websites.

Display:

- Project name.
- Domain.
- GitHub repository.
- Current branch.
- Current deployed commit.
- Application status.
- CPU usage.
- Memory usage.
- Disk usage.
- Last deployment.
- Latest deployment result.

Provide individual project actions:

- Open Website.
- Deploy.
- Fetch Updates.
- Restart.
- Stop.
- Start.
- View Logs.
- Manage Environment.
- View Releases.
- Rollback.
- Delete Project.

Add search, filtering and sorting.

## 7. Global server dashboard

Provide a central overview of the entire VM:

- Total websites.
- Online websites.
- Offline websites.
- Failed deployments.
- Active deployments.
- Total CPU usage.
- Total RAM usage.
- Total disk usage.
- Available disk space.
- Docker container count.
- Nginx status.
- SSL certificate status.
- GitHub synchronization status.

Show resource usage both globally and per project.

## 8. Project isolation and security

This is mandatory.

- Each application must have an isolated working directory.
- Use separate environment files.
- Never share secrets between projects.
- Restrict project filesystem access.
- Prevent one project from accessing another project's private files.
- Use separate containers or restricted service users.
- Never expose Docker socket access to deployed applications.
- Restrict deployment worker permissions.
- Validate all domain names and deployment configurations.
- Protect management APIs with authentication and authorization.

## 9. Project-specific rollback

Each project must have its own release history.

Example:

Website A:
- Release 1
- Release 2
- Release 3 (Live)

Website B:
- Release 1
- Release 2 (Live)

Rolling back Website A must not change Website B.

Support automatic and manual rollback independently for every project.

## 10. Resource management

Since multiple websites will run on one VM:

- Monitor memory and CPU per application.
- Configure optional CPU and memory limits.
- Configure deployment concurrency.
- Check available disk space before builds.
- Clean old release directories safely.
- Avoid excessive simultaneous builds.
- Provide warnings when the VM approaches resource limits.

## 11. Final requirements

I want one central application that can manage my entire VM.

I should never need to manually configure Nginx, create application folders, assign ports, configure deployment scripts or SSH into the server for routine website management.

Nexus Deploy should automate these tasks through its backend.

IMPORTANT:
Build a genuine multi-project deployment platform, not a dashboard that merely displays multiple websites.

All project operations must be independently implemented, persistent, secure and functional.

Do not use mock data or simulated deployment results.