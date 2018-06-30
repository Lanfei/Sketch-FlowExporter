/*
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const sketch = require('sketch/dom');
const {Document, Page, Artboard, Rectangle, Flow, HotSpot} = sketch;
const UI = require('sketch/ui');

const dialog = require('@skpm/dialog');
const fs = require('@skpm/fs');
const path = require('@skpm/path');

import * as common from './lib/common';
import * as prefs from './prefs';


export default function(context) {
  let document = Document.getSelectedDocument();

  let prototypeData = {
    title: null,
    flowStartArtboardId: null,
    artboards: {},
  };

  let artboardsById = {};

  let flowStartArtboards = [];
  let hasArtboards = null;

  // find a starting artboard
  document.pages.forEach(page => {
    page.layers.forEach(artboard => {
      if (!(artboard instanceof Artboard)) {
        return;
      }

      hasArtboards = true;

      artboardsById[artboard.id] = artboard;

      if (artboard.flowStartPoint) {
        flowStartArtboards.push(artboard);
      }
    });
  });

  // error out if no artboards found
  if (!hasArtboards) {
    UI.message('❌ No artboards in this document');
    return;
  }

  // find the best starting point
  let flowStartArtboard = null;
  if (flowStartArtboards.length) {
    // there are artboards marked as starting points. find the best one
    // TODO: better handling of multiple starting artboards
    flowStartArtboard = flowStartArtboards[0];
  } else {
    // there aren't any artboards marked as starting points, pick a random artboard
    // TODO: better handling of this (e.g. pick the top-left most one on the current page?)
    flowStartArtboard = Object.values(artboardsById)[0];
    // TODO: should we set the chosen one as the prototyping start point?
    // flowStartArtboard.flowStartPoint = true;
  }

  // ask user to pick a directory, with default export name pre-filled
  let defaultExportPath = 'ExportedFlow';
  let fileURL = document.sketchObject.fileURL();
  if (fileURL) {
    fileURL = String(fileURL.path());
    // defaultExportPath = path.join(
    //     path.dirname(fileURL),
    let documentName = path.basename(fileURL).replace(/\.[^.]+$/, ''); // strip extension
    prototypeData.title = documentName;
    defaultExportPath = `${documentName}_ExportedFlow`;
  }

  let rootPath = dialog.showSaveDialog(document.sketchObject, {
    defaultPath: defaultExportPath,
    nameFieldLabel: 'Export directory name:',
    buttonLabel: 'Export',
  });

  if (!rootPath) {
    return;
  }

  // confirm overwrite
  if (fs.existsSync(rootPath)) {
    let confirm = (0 === dialog.showMessageBox(document.sketchObject, {
      type: 'question',
      buttons: ['Overwrite', 'Cancel'],
      title: 'Directory exists, overwrite?',
      message: 'The output directory you chose already exists. Are you sure you want to overwrite it?\n\n' + rootPath,
      icon: NSImage.alloc().initWithContentsOfFile(context.plugin.urlForResourceNamed('icon.png').path()),
    }));
    if (!confirm) {
      return;
    }
    common.rmdirRecursive(rootPath);
  }

  // export!
  prototypeData.flowStartArtboardId = flowStartArtboard.id;

  let artboardsToProcess = [flowStartArtboard.id];
  let processedArtboards = {};

  // process artboards
  let processNextArtboard_ = () => {
    let artboardId = artboardsToProcess.shift();
    if (!artboardId) {
      return false;
    }

    let artboard = artboardsById[artboardId];
    if (processedArtboards[artboard.id]) {
      return true;
    }

    processedArtboards[artboard.id] = true;

    // export the artboard image to PNG
    let {hasFixedLayers} = exportArtboard(context, rootPath, artboard);

    // prepare metadata
    let artboardData = {
      title: artboard.name,
      width: artboard.frame.width,
      height: artboard.frame.height,
      hotspots: [],
      hasFixedLayers
    };

    let preset = artboard.sketchObject.preset();
    if (preset) {
      artboardData.presetWidth = preset.width();
      artboardData.presetHeight = preset.height();
    }

    let findHotspotsUnderSubtree_ = (nativeParentGroup, hotspotOverrides) => {
      let layersWithFlow = common.getAllLayersMatchingPredicate(
          nativeParentGroup,
          NSPredicate.predicateWithFormat('flow != nil'));
      for (let nativeLayer of layersWithFlow) {
        let layerId = String(nativeLayer.objectID());
        let nativeFlow = nativeLayer.flow();
        let frame = nativeLayer.frame();
        let rectangle = new Rectangle(frame.x(), frame.y(), frame.width(), frame.height());
        let isFixed = common.isLayerFixedToViewport(nativeLayer);
        let parent = nativeLayer.parentGroup();
        while (parent && !(parent instanceof MSArtboardGroup || parent instanceof MSSymbolMaster)) {
          rectangle.offset(parent.frame().x(), parent.frame().y());
          isFixed = isFixed || common.isLayerFixedToViewport(parent);
          parent = parent.parentGroup();
        }

        let target = String(nativeFlow.destinationArtboardID());
        if (layerId in hotspotOverrides) {
          target = hotspotOverrides[layerId];
        }

        if (target && nativeFlow.isValidFlowConnection()) {
          if (target !== String(Flow.BackTarget)) {
            artboardsToProcess.push(target);
          }

          artboardData.hotspots.push({rectangle, target, isFixed});
        }
      }

      let symbolInstances = common.getAllLayersMatchingPredicate(
          nativeParentGroup,
          NSPredicate.predicateWithFormat('className == %@', 'MSSymbolInstance'))
          .filter(symbolInstance => doesSymbolInstanceHaveFlows(symbolInstance));
      for (let symbolInstance of symbolInstances) {
        // symbol instance has flows inside it; make a copy of it,
        // detach it to a group, find the hotspots, and then kill the copy
        let overrides = {...symbolInstance.overrides(), ...hotspotOverrides};
        let dup = symbolInstance.copy();
        symbolInstance.parentGroup().addLayer(dup);
        dup = dup.detachByReplacingWithGroup();
        findHotspotsUnderSubtree_(dup, overrides);
        dup.removeFromParent();
      }
    };

    findHotspotsUnderSubtree_(artboard.sketchObject, {});

    // store metadata
    prototypeData.artboards[artboard.id] = artboardData;
    return true;
  };

  while (processNextArtboard_());

  let htmlPath = `${rootPath}/index.html`;
  fs.writeFileSync(htmlPath, makeIndexHtml(context, prototypeData));

  ['jquery.min.js'].forEach(addlFile => {
    fs.copyFileSync(context.plugin.urlForResourceNamed(addlFile).path(), `${rootPath}/${addlFile}`);
  });

  NSWorkspace.sharedWorkspace().openFile(htmlPath);
  UI.message('✅ Exported!');
}


function exportArtboard(context, destPath, artboard) {
  // TODO: when sketch.export offers more control, switch to it
  // sketch.export(artboard, {
  //   formats: 'png',
  //   'use-id-for-name': true,
  //   overwriting: true,
  //   output: destPath,
  //   scales: String(prefs.resolveDocumentPrefs(context, context.document).exportScale),
  // });

  // we're going to do two exports: first, all the non-fixed layers, and then, all the
  // fixed layers. make a copy of the artboard because we're going to do a lot of
  // showing and hiding things
  let hasFixedLayers = false;

  let artboardCopy = artboard.sketchObject.copy();
  let visibleFixedLayers = common.getAllLayersMatchingPredicate(
      artboardCopy,
      NSPredicate.predicateWithFormat('(isFixedToViewport = 1) AND (isVisible = 1)'));
  let layersNotToHideForFixedExport = new Set();
  layersNotToHideForFixedExport.add(artboardCopy); // don't hide the artboard itself
  for (let fixedLayer of visibleFixedLayers) {
    // don't hide the fixed layer or any descendants
    Array.from(fixedLayer.children()).forEach(l => layersNotToHideForFixedExport.add(l));
    // don't hide any of its ancestors
    let layer = fixedLayer;
    while (layer && !(layer instanceof MSPage) && !(layer instanceof MSArtboardGroup)) {
      layersNotToHideForFixedExport.add(layer);
      layer = layer.parentGroup();
    }
  }

  // do one export of the non-fixed content by hiding all fixed layers
  visibleFixedLayers.forEach(l => l.setIsVisible(false));
  doExport('');
  if (visibleFixedLayers.length) {
    // show the fixed layers again, hide everything else, and export
    visibleFixedLayers.forEach(l => l.setIsVisible(true));
    Array.from(artboardCopy.children())
        .filter(l => !layersNotToHideForFixedExport.has(l))
        .forEach(l => l.setIsVisible(false));
    artboardCopy.setIncludeBackgroundColorInExport(false);
    doExport('_fixed');
    hasFixedLayers = true;
  }

  return {hasFixedLayers};

  function doExport(suffix) {
    let ancestry = MSImmutableLayerAncestry.ancestryWithMSLayer_(artboardCopy);
    let exportRequest = MSExportRequest.exportRequestsFromLayerAncestry_(ancestry).firstObject();
    exportRequest.format = 'png';
    exportRequest.scale = prefs.resolveDocumentPrefs(context, context.document).exportScale;
    context.document.saveArtboardOrSlice_toFile_(
        exportRequest,
        path.join(destPath, artboard.sketchObject.objectID() + suffix + '.png'));
  }
}


function doesSymbolInstanceHaveFlows(nativeSymbolInstance) {
  // TODO: cache true/false for a given master
  if (common.getAllLayersMatchingPredicate(
    nativeSymbolInstance.symbolMaster(),
    NSPredicate.predicateWithFormat('flow != nil')).length) {
    return true;
  }

  // check for symbol instance children that have flows
  let symbolInstances = common.getAllLayersMatchingPredicate(
      nativeSymbolInstance.symbolMaster(),
      NSPredicate.predicateWithFormat('className == %@', 'MSSymbolInstance'));
  for (let symbolInstance of symbolInstances) {
    if (doesSymbolInstanceHaveFlows(symbolInstance)) {
      return true;
    }
  }

  return false;
}


function makeIndexHtml(context, prototypeData) {
  let template = fs.readFileSync(context.plugin.urlForResourceNamed('index_template.html').path(), {encoding: 'utf8'});
  let expanded = hydrate(template, {
    prototypeData,
    showHotspots: prefs.resolveDocumentPrefs(context, context.document).showHotspots,
  });
  return expanded;
}


function hydrate(template, context) {
  return template.replace(/<%=(.*)%>/g, (_, expr) => {
    let decls = Object.keys(context)
        .map(key => `var ${key} = ${JSON.stringify(context[key])};`)
        .join('');
    return Function(`"use strict";${decls};return ${expr};`)();
  });
}
