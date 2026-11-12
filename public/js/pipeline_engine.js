/**
 * WebDep Organic Fluid Water Pipeline Engine
 * Hardware-accelerated fluid pipeline visualization with smooth state transitions,
 * dynamic vial fill levels, liquid physics, and stage indicators
 */

import { PIPELINE_STAGES } from './state.js';

const waterPipelines = {};

function initWaterPipelineDOM(container, containerId, stages = PIPELINE_STAGES) {
  const isCompact = container.classList.contains('card-pipeline-track') ||
    containerId.startsWith('db-pipeline-track') ||
    containerId.startsWith('service-pipeline-track') ||
    container.closest('.card') !== null;
  const wrapperClass = isCompact ? 'water-pipeline-wrapper compact' : 'water-pipeline-wrapper';
  container.innerHTML = `
    <div class="${wrapperClass}" id="water-wrapper-${containerId}">
      ${stages.map((s, idx) => `
        <div class="water-stage-unit" data-unit-idx="${idx}">
          <div class="water-node-vial" data-vial-idx="${idx}">
            <div class="water-vial-bg"></div>
            <div class="water-vial-liquid" style="height: 0%;">
              <div class="water-wave-surface"></div>
            </div>
            <div class="water-vial-content">
              <span class="water-vial-num">${idx + 1}</span>
              <svg class="water-vial-icon water-vial-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <svg class="water-vial-icon water-vial-cross" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </div>
          </div>
          <div class="water-node-info">
            <div class="water-node-name">${s.label}</div>
            <div class="water-node-sub">Queued</div>
          </div>
          ${idx < stages.length - 1 ? `
            <div class="water-pipe-segment" data-pipe-idx="${idx}">
              <div class="water-pipe-glass">
                <div class="water-pipe-liquid" style="width: 0%;">
                  <div class="water-pipe-meniscus"></div>
                </div>
              </div>
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function getOrCacheStageNodes(pipeline, container) {
  if (pipeline.stageNodes && pipeline.stageNodes.length === (pipeline.stages || PIPELINE_STAGES).length) {
    if (pipeline.stageNodes[0]?.unit && pipeline.stageNodes[0].unit.isConnected) {
      return pipeline.stageNodes;
    }
  }
  const stages = pipeline.stages || PIPELINE_STAGES;
  pipeline.stageNodes = stages.map((s, idx) => {
    const unit = container.querySelector(`.water-stage-unit[data-unit-idx="${idx}"]`);
    if (!unit) return null;
    return {
      unit,
      vial: unit.querySelector('.water-node-vial'),
      liquid: unit.querySelector('.water-vial-liquid'),
      num: unit.querySelector('.water-vial-num'),
      check: unit.querySelector('.water-vial-check'),
      cross: unit.querySelector('.water-vial-cross'),
      name: unit.querySelector('.water-node-name'),
      sub: unit.querySelector('.water-node-sub'),
      pipeLiquid: unit.querySelector('.water-pipe-liquid'),
      meniscus: unit.querySelector('.water-pipe-meniscus'),
      _lastVialClass: '',
      _lastSubText: '',
      _lastSubClass: '',
      _lastNameClass: '',
      _lastPipeClass: '',
      _lastNumDisplay: '',
      _lastCheckDisplay: '',
      _lastCrossDisplay: '',
      _lastHeight: -1,
      _lastWidth: -1,
    };
  });
  return pipeline.stageNodes;
}

function updateWaterDOM(pipeline) {
  const container = document.getElementById(pipeline.containerId);
  if (!container) return;

  const stageNodes = getOrCacheStageNodes(pipeline, container);
  const stages = pipeline.stages || PIPELINE_STAGES;
  const maxP = stages.length;
  const P = pipeline.currentProgress;
  const isFailed = pipeline.status === 'failed';
  const isSuccess = pipeline.status === 'success';
  const activeIdx = pipeline.activeStageIdx ?? -1;
  const failedIdx = isFailed ? pipeline.failedStageIdx : -1;
  const isDraining = (pipeline.targetProgress < pipeline.currentProgress) || (pipeline.status === 'idle' && P > 0);
  const drainStageIdx = isDraining ? Math.min(stages.length - 1, Math.max(0, Math.floor(P))) : -1;

  stages.forEach((s, idx) => {
    const nodes = stageNodes ? stageNodes[idx] : null;
    if (!nodes) return;

    const { vial, liquid, num, check, cross, name, sub, pipeLiquid, meniscus } = nodes;
    let vialHeight = 0;

    const setDisplay = (el, val, prop) => {
      if (el && nodes[prop] !== val) {
        el.style.display = val;
        nodes[prop] = val;
      }
    };
    const setClass = (el, val, prop) => {
      if (el && nodes[prop] !== val) {
        el.className = val;
        nodes[prop] = val;
      }
    };
    const setText = (el, val, prop) => {
      if (el && nodes[prop] !== val) {
        el.textContent = val;
        nodes[prop] = val;
      }
    };

    // Draining
    if (isDraining) {
      if (idx > drainStageIdx) {
        vialHeight = 0;
        setClass(vial, 'water-node-vial queued', '_lastVialClass');
        setDisplay(num, 'block', '_lastNumDisplay');
        setDisplay(check, 'none', '_lastCheckDisplay');
        setDisplay(cross, 'none', '_lastCrossDisplay');
        setText(sub, pipeline.status === 'idle' ? 'Idle' : 'Queued', '_lastSubText');
        setClass(sub, 'water-node-sub queued', '_lastSubClass');
        setClass(name, 'water-node-name queued', '_lastNameClass');
        if (pipeLiquid) {
          if (nodes._lastPipeFrac !== 0) {
            pipeLiquid.style.transform = 'scaleX(0)';
            pipeLiquid.style.width = '0%';
            nodes._lastPipeFrac = 0;
          }
          setClass(pipeLiquid, 'water-pipe-liquid empty', '_lastPipeClass');
          if (meniscus) meniscus.style.opacity = '0';
        }
      } else if (idx < drainStageIdx) {
        vialHeight = 100;
        setClass(vial, 'water-node-vial completed', '_lastVialClass');
        setDisplay(num, 'none', '_lastNumDisplay');
        setDisplay(check, 'block', '_lastCheckDisplay');
        setDisplay(cross, 'none', '_lastCrossDisplay');
        setText(sub, 'Done', '_lastSubText');
        setClass(sub, 'water-node-sub completed', '_lastSubClass');
        setClass(name, 'water-node-name completed', '_lastNameClass');
        if (pipeLiquid) {
          if (nodes._lastPipeFrac !== 1) {
            pipeLiquid.style.transform = 'scaleX(1)';
            pipeLiquid.style.width = '100%';
            nodes._lastPipeFrac = 1;
          }
          setClass(pipeLiquid, 'water-pipe-liquid filled', '_lastPipeClass');
          if (meniscus) meniscus.style.opacity = '0';
        }
      } else {
        const fraction = Math.max(0, Math.min(1.0, P - idx));
        if (idx < stages.length - 1) {
          if (fraction >= 0.6) {
            const pipeFrac = (fraction - 0.6) / 0.4;
            const pipeWidth = Math.min(100, Math.max(0, pipeFrac * 100));
            if (pipeLiquid) {
              const roundedPFrac = Math.round((pipeWidth / 100) * 1000) / 1000;
              if (nodes._lastPipeFrac !== roundedPFrac) {
                pipeLiquid.style.transform = `scaleX(${roundedPFrac})`;
                pipeLiquid.style.width = `${(roundedPFrac * 100).toFixed(1)}%`;
                nodes._lastPipeFrac = roundedPFrac;
              }
              setClass(pipeLiquid, 'water-pipe-liquid draining', '_lastPipeClass');
              if (meniscus) meniscus.style.opacity = '0';
            }
            vialHeight = 100;
            setClass(vial, 'water-node-vial active', '_lastVialClass');
            setDisplay(num, 'block', '_lastNumDisplay');
            setDisplay(check, 'none', '_lastCheckDisplay');
            setDisplay(cross, 'none', '_lastCrossDisplay');
            setText(sub, 'Emptying...', '_lastSubText');
            setClass(sub, 'water-node-sub draining active', '_lastSubClass');
            setClass(name, 'water-node-name active', '_lastNameClass');
          } else {
            if (pipeLiquid) {
              if (nodes._lastPipeFrac !== 0) {
                pipeLiquid.style.transform = 'scaleX(0)';
                pipeLiquid.style.width = '0%';
                nodes._lastPipeFrac = 0;
              }
              setClass(pipeLiquid, 'water-pipe-liquid empty', '_lastPipeClass');
              if (meniscus) meniscus.style.opacity = '0';
            }
            vialHeight = Math.min(100, Math.max(0, (fraction / 0.6) * 100));
            setClass(vial, 'water-node-vial draining', '_lastVialClass');
            setDisplay(num, 'block', '_lastNumDisplay');
            setDisplay(check, 'none', '_lastCheckDisplay');
            setDisplay(cross, 'none', '_lastCrossDisplay');
            setText(sub, 'Emptying...', '_lastSubText');
            setClass(sub, 'water-node-sub draining', '_lastSubClass');
            setClass(name, 'water-node-name active', '_lastNameClass');
          }
        } else {
          vialHeight = Math.min(100, Math.max(0, (fraction / 0.8) * 100));
          setClass(vial, 'water-node-vial draining', '_lastVialClass');
          setDisplay(num, 'block', '_lastNumDisplay');
          setDisplay(check, 'none', '_lastCheckDisplay');
          setDisplay(cross, 'none', '_lastCrossDisplay');
          setText(sub, 'Emptying...', '_lastSubText');
          setClass(sub, 'water-node-sub draining', '_lastSubClass');
          setClass(name, 'water-node-name active', '_lastNameClass');
        }
      }
    }
    // Forward filling
    else {
      if (P >= idx + 0.6) {
        vialHeight = 100;
      } else if (P > idx) {
        vialHeight = Math.min(100, Math.max(0, ((P - idx) / 0.6) * 100));
      }

      if (isFailed && idx === failedIdx && P >= idx + 0.5) {
        setClass(vial, 'water-node-vial failed', '_lastVialClass');
        setDisplay(num, 'none', '_lastNumDisplay');
        setDisplay(check, 'none', '_lastCheckDisplay');
        setDisplay(cross, 'block', '_lastCrossDisplay');
        setText(sub, 'Failed', '_lastSubText');
        setClass(sub, 'water-node-sub failed', '_lastSubClass');
        setClass(name, 'water-node-name failed', '_lastNameClass');
      } else if ((idx < activeIdx && P >= idx + 0.6) || (isSuccess && P >= idx + 0.6)) {
        setClass(vial, 'water-node-vial completed', '_lastVialClass');
        setDisplay(num, 'none', '_lastNumDisplay');
        setDisplay(check, 'block', '_lastCheckDisplay');
        setDisplay(cross, 'none', '_lastCrossDisplay');
        setText(sub, 'Done', '_lastSubText');
        setClass(sub, 'water-node-sub completed', '_lastSubClass');
        setClass(name, 'water-node-name completed', '_lastNameClass');
      } else if (P > idx) {
        setClass(vial, 'water-node-vial active', '_lastVialClass');
        setDisplay(num, 'block', '_lastNumDisplay');
        setDisplay(check, 'none', '_lastCheckDisplay');
        setDisplay(cross, 'none', '_lastCrossDisplay');
        const activeSub = vialHeight >= 99 ? `${s.label}...` : 'Filling...';
        setText(sub, activeSub, '_lastSubText');
        setClass(sub, 'water-node-sub active', '_lastSubClass');
        setClass(name, 'water-node-name active', '_lastNameClass');
      } else {
        setClass(vial, 'water-node-vial queued', '_lastVialClass');
        setDisplay(num, 'block', '_lastNumDisplay');
        setDisplay(check, 'none', '_lastCheckDisplay');
        setDisplay(cross, 'none', '_lastCrossDisplay');
        setText(sub, pipeline.status === 'idle' ? 'Idle' : 'Queued', '_lastSubText');
        setClass(sub, 'water-node-sub queued', '_lastSubClass');
        setClass(name, 'water-node-name queued', '_lastNameClass');
      }

      if (idx < stages.length - 1 && pipeLiquid) {
        let pipeWidth = 0;
        if (P >= idx + 1.0) {
          pipeWidth = 100;
          setClass(pipeLiquid, 'water-pipe-liquid filled', '_lastPipeClass');
          if (meniscus) meniscus.style.opacity = '0';
        } else if (P > idx + 0.6) {
          pipeWidth = Math.min(100, Math.max(0, ((P - (idx + 0.6)) / 0.4) * 100));
          setClass(pipeLiquid, 'water-pipe-liquid flowing', '_lastPipeClass');
          if (meniscus) meniscus.style.opacity = '1';
        } else {
          pipeWidth = 0;
          setClass(pipeLiquid, 'water-pipe-liquid empty', '_lastPipeClass');
          if (meniscus) meniscus.style.opacity = '0';
        }
        const roundedPFrac = Math.round((pipeWidth / 100) * 1000) / 1000;
        if (nodes._lastPipeFrac !== roundedPFrac) {
          pipeLiquid.style.transform = `scaleX(${roundedPFrac})`;
          pipeLiquid.style.width = `${(roundedPFrac * 100).toFixed(1)}%`;
          nodes._lastPipeFrac = roundedPFrac;
        }
      }
    }

    if (liquid) {
      const roundedVFrac = Math.round((vialHeight / 100) * 1000) / 1000;
      if (nodes._lastVialFrac !== roundedVFrac) {
        liquid.style.transform = `scaleY(${roundedVFrac})`;
        liquid.style.height = `${(roundedVFrac * 100).toFixed(1)}%`;
        nodes._lastVialFrac = roundedVFrac;
      }
    }
  });

  if (isSuccess && P >= maxP - 0.05) {
    if (pipeline.containerId === 'main-pipeline-track' || pipeline.containerId === 'overview-pipeline-track') {
      const badge = document.getElementById('pipeline-status-badge');
      if (badge && !badge.textContent.includes('DEPLOYED')) {
        badge.textContent = 'DEPLOYED (LIVE)';
        badge.className = 'badge badge-success';
      }
      const overviewBadge = document.getElementById('active-dep-kind');
      if (overviewBadge && !overviewBadge.textContent.includes('LIVE')) {
        overviewBadge.textContent = 'DEPLOYED';
        overviewBadge.className = 'badge badge-success';
      }
      if (typeof window.renderWebsiteWorkspaceHeader === 'function') {
        window.renderWebsiteWorkspaceHeader();
      }
    }
    const svcMatch = pipeline.containerId.match(/^service-pipeline-track-(\d+)$/);
    if (svcMatch) {
      const sBadge = document.getElementById(`service-pipeline-badge-${svcMatch[1]}`);
      if (sBadge && !sBadge.textContent.includes('READY')) {
        sBadge.textContent = 'READY';
        sBadge.className = 'badge badge-success';
      }
    }
  } else if (isDraining && P > 0.1) {
    if (pipeline.containerId === 'main-pipeline-track' || pipeline.containerId === 'overview-pipeline-track') {
      const badge = document.getElementById('pipeline-status-badge');
      if (badge && !badge.textContent.includes('STOPPING')) {
        badge.textContent = 'STOPPING...';
        badge.className = 'badge badge-warning';
      }
    }
    const svcMatch = pipeline.containerId.match(/^service-pipeline-track-(\d+)$/);
    if (svcMatch) {
      const sBadge = document.getElementById(`service-pipeline-badge-${svcMatch[1]}`);
      if (sBadge && !sBadge.textContent.includes('STOPPING')) {
        sBadge.textContent = 'STOPPING...';
        sBadge.className = 'badge badge-warning';
      }
    }
  } else if (pipeline.status === 'idle' && P <= 0.05) {
    if (pipeline.containerId === 'main-pipeline-track' || pipeline.containerId === 'overview-pipeline-track') {
      const badge = document.getElementById('pipeline-status-badge');
      if (badge && badge.textContent !== 'IDLE') {
        badge.textContent = 'IDLE';
        badge.className = 'badge badge-neutral';
      }
    }
    const svcMatch = pipeline.containerId.match(/^service-pipeline-track-(\d+)$/);
    if (svcMatch) {
      const sBadge = document.getElementById(`service-pipeline-badge-${svcMatch[1]}`);
      if (sBadge && sBadge.textContent !== 'STOPPED' && sBadge.textContent !== 'IDLE') {
        sBadge.textContent = 'STOPPED';
        sBadge.className = 'badge badge-neutral';
      }
    }
  }
}

function startWaterLoop(pipeline) {
  if (pipeline.isLooping) return;
  pipeline.isLooping = true;

  let lastTime = performance.now();

  function step(now) {
    const container = document.getElementById(pipeline.containerId);
    if (!container) {
      pipeline.isLooping = false;
      return;
    }

    const dt = Math.min(Math.max((now - lastTime) / 1000, 0.001), 0.05);
    lastTime = now;
    const diff = pipeline.targetProgress - pipeline.currentProgress;

    const maxSpeed = 0.55 * dt;
    const factor = 1 - Math.exp(-dt * 4.2);
    const speed = Math.max(0.12 * dt, Math.min(maxSpeed, Math.abs(diff) * factor));

    if (Math.abs(diff) > 0.0008) {
      if (diff > 0) {
        pipeline.currentProgress = Math.min(pipeline.targetProgress, pipeline.currentProgress + speed);
      } else {
        pipeline.currentProgress = Math.max(pipeline.targetProgress, pipeline.currentProgress - speed);
      }
      updateWaterDOM(pipeline);
      requestAnimationFrame(step);
    } else {
      pipeline.currentProgress = pipeline.targetProgress;
      updateWaterDOM(pipeline);
      pipeline.isLooping = false;
    }
  }

  requestAnimationFrame(step);
}

function renderPipelineStages(containerId, currentStage, currentStatus, depId = null, stages = PIPELINE_STAGES) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const maxP = stages.length;

  const createPipelineObj = () => ({
    containerId,
    stages,
    currentProgress: (currentStatus === 'success' ? maxP : 0.0),
    targetProgress: (currentStatus === 'success' ? maxP : 0.0),
    status: currentStatus,
    activeStageIdx: -1,
    failedStageIdx: -1,
    lastDeploymentId: depId,
    isLooping: false,
    stageNodes: null,
  });

  const existingWrapper = container.querySelector('.water-pipeline-wrapper');
  if (!existingWrapper || waterPipelines[containerId]?.stages !== stages) {
    initWaterPipelineDOM(container, containerId, stages);
    waterPipelines[containerId] = createPipelineObj();
  }

  let pipeline = waterPipelines[containerId];
  if (!pipeline) {
    pipeline = createPipelineObj();
    waterPipelines[containerId] = pipeline;
  }
  pipeline.stages = stages;

  if (depId && pipeline.lastDeploymentId && pipeline.lastDeploymentId !== depId && (currentStatus === 'running' || currentStatus === 'pending')) {
    pipeline.currentProgress = 0.0;
    pipeline.lastDeploymentId = depId;
  } else if (depId && !pipeline.lastDeploymentId) {
    pipeline.lastDeploymentId = depId;
  }

  pipeline.status = currentStatus;
  const currentIndex = stages.findIndex((s) => s.id === currentStage);

  if (currentStatus === 'idle') {
    pipeline.targetProgress = 0.0;
    pipeline.activeStageIdx = -1;
    pipeline.failedStageIdx = -1;
    if (!pipeline.isLooping) {
      pipeline.currentProgress = 0.0;
      updateWaterDOM(pipeline);
      return;
    }
  } else if (currentStatus === 'failed') {
    pipeline.failedStageIdx = currentIndex >= 0 ? currentIndex : 0;
    pipeline.activeStageIdx = pipeline.failedStageIdx;
    pipeline.targetProgress = pipeline.failedStageIdx + 0.6;
    if (!pipeline.isLooping) {
      pipeline.currentProgress = pipeline.targetProgress;
      updateWaterDOM(pipeline);
      return;
    }
  } else if (currentStatus === 'success') {
    pipeline.activeStageIdx = stages.length - 1;
    pipeline.failedStageIdx = -1;
    pipeline.targetProgress = maxP;
    if (!pipeline.isLooping) {
      pipeline.currentProgress = maxP;
      updateWaterDOM(pipeline);
      return;
    }
  } else {
    pipeline.activeStageIdx = currentIndex >= 0 ? currentIndex : 0;
    pipeline.failedStageIdx = -1;
    pipeline.targetProgress = pipeline.activeStageIdx + 0.6;
  }

  startWaterLoop(pipeline);
}

function resetWaterPipeline(containerId) {
  const p = waterPipelines[containerId];
  if (p) {
    p.currentProgress = 0.0;
    p.targetProgress = 0.6;
    p.status = 'running';
    p.activeStageIdx = 0;
    p.failedStageIdx = -1;
    p.lastDeploymentId = null;
    updateWaterDOM(p);
    startWaterLoop(p);
  }
}

// Window bindings
window.waterPipelines = waterPipelines;
window.renderPipelineStages = renderPipelineStages;
window.resetWaterPipeline = resetWaterPipeline;

export {
  waterPipelines,
  renderPipelineStages,
  resetWaterPipeline,
};

