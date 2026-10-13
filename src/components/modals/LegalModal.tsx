import React, { useState } from 'react';
import { ShieldAlert, X, Scale, FileText, CheckCircle2, AlertTriangle, Cpu } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';

export const LegalModal: React.FC = () => {
  const { isLegalModalOpen, setLegalModalOpen } = useBimStore();
  const [activeTab, setActiveTab] = useState<'trademarks' | 'engineering' | 'ai' | 'warranty'>('trademarks');

  if (!isLegalModalOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
      <div className="bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-2xl w-full max-w-2xl text-[#cccccc] text-xs overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#1e1e1e] border-b border-[#333333] shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 rounded bg-[#094771] border border-[#007acc] flex items-center justify-center text-[#38bdf8]">
              <Scale size={16} />
            </div>
            <div>
              <div className="font-semibold text-white text-sm">BIMWorks Legal Notices &amp; Disclaimers</div>
              <div className="text-[10px] text-[#9ca3af]">Open Source Architectural BIM Platform — GPL-3.0</div>
            </div>
          </div>
          <button
            onClick={() => setLegalModalOpen(false)}
            className="p-1.5 hover:bg-[#333333] rounded text-[#858585] hover:text-white transition-colors"
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center px-4 bg-[#202020] border-b border-[#333333] space-x-2 shrink-0">
          <button
            onClick={() => setActiveTab('trademarks')}
            className={`flex items-center space-x-1.5 py-2.5 px-3 border-b-2 font-medium transition-colors ${
              activeTab === 'trademarks'
                ? 'border-[#38bdf8] text-[#38bdf8]'
                : 'border-transparent text-[#9ca3af] hover:text-white'
            }`}
          >
            <FileText size={13} />
            <span>Trademarks &amp; Fair Use</span>
          </button>
          <button
            onClick={() => setActiveTab('engineering')}
            className={`flex items-center space-x-1.5 py-2.5 px-3 border-b-2 font-medium transition-colors ${
              activeTab === 'engineering'
                ? 'border-[#f59e0b] text-[#f59e0b]'
                : 'border-transparent text-[#9ca3af] hover:text-white'
            }`}
          >
            <AlertTriangle size={13} />
            <span>A/E Professional Liability</span>
          </button>
          <button
            onClick={() => setActiveTab('ai')}
            className={`flex items-center space-x-1.5 py-2.5 px-3 border-b-2 font-medium transition-colors ${
              activeTab === 'ai'
                ? 'border-[#a855f7] text-[#a855f7]'
                : 'border-transparent text-[#9ca3af] hover:text-white'
            }`}
          >
            <Cpu size={13} />
            <span>Generative AI Notice</span>
          </button>
          <button
            onClick={() => setActiveTab('warranty')}
            className={`flex items-center space-x-1.5 py-2.5 px-3 border-b-2 font-medium transition-colors ${
              activeTab === 'warranty'
                ? 'border-[#10b981] text-[#10b981]'
                : 'border-transparent text-[#9ca3af] hover:text-white'
            }`}
          >
            <ShieldAlert size={13} />
            <span>GPL-3.0 Warranty</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 overflow-y-auto space-y-4 text-[11px] leading-relaxed select-text">
          {activeTab === 'trademarks' && (
            <div className="space-y-3">
              <div className="bg-[#1e293b] border border-[#334155] p-3 rounded text-[#cbd5e1]">
                <span className="font-semibold text-white block mb-1">Trademark Notice &amp; Non-Affiliation</span>
                Autodesk®, Revit®, Revit LT®, and DWG™ are registered trademarks or trademarks of Autodesk, Inc., and/or its subsidiaries and affiliates. buildingSMART® and IFC® are trademarks of buildingSMART International Ltd.
              </div>
              <p>
                <strong className="text-white">BIMWorks is an independent open-source project.</strong> It is <strong>NOT</strong> affiliated with, associated with, sponsored by, endorsed by, certified by, or officially connected with Autodesk, Inc., buildingSMART International Ltd., or any of their affiliates.
              </p>
              <p>
                Any references to Autodesk, Revit, or Revit LT user interface conventions, hotkey commands, ribbon layouts, terminology, family structures, or workflow concepts are made <strong>strictly for descriptive, comparative, educational, and interoperability purposes under nominative fair use</strong>.
              </p>
              <p>
                BIMWorks is an original clean-room implementation built from open international standards (buildingSMART IFC4 ADD2) and open-source libraries. It contains no proprietary code, binaries, or reverse-engineered intellectual property.
              </p>
            </div>
          )}

          {activeTab === 'engineering' && (
            <div className="space-y-3">
              <div className="bg-[#451a03] border border-[#b45309] p-3 rounded text-[#fed7aa]">
                <div className="flex items-center space-x-2 font-bold text-[#f59e0b] mb-1">
                  <AlertTriangle size={15} />
                  <span>CRITICAL NOTICE: NOT A STAMPED CONTRACT DOCUMENT</span>
                </div>
                BIMWorks is computer software, NOT a licensed architect, professional engineer, structural consultant, or code enforcement official.
              </div>
              <div className="space-y-2">
                <p>
                  <strong>1. Instruments of Service — Uncertified Drafts:</strong> All 2D plans, vector slices, 3D models, schedules, sheet layouts, dimension strings, and exports (.ifc, .orlt, .pdf, .svg) are uncertified instruments of service and do not constitute sealed or stamped construction documents.
                </p>
                <p>
                  <strong>2. Do Not Scale Drawings:</strong> Field verification of all dimensions, levels, clearances, structural bearings, and existing job-site conditions is mandatory prior to ordering materials, fabrication, or construction.
                </p>
                <p>
                  <strong>3. Sole User Responsibility for Code Compliance:</strong> The licensed Architect of Record or Professional Engineer of Record bears exclusive responsibility for verifying all life safety, egress, fire ratings, structural calculations, and building code compliance (IBC, IRC, Eurocodes, ADA).
                </p>
                <p>
                  <strong>4. Zero Liability:</strong> The authors and contributors assume no liability for site errors, construction defects, change orders, cost overruns, delays, or physical damage.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'ai' && (
            <div className="space-y-3">
              <div className="bg-[#3b0764] border border-[#7e22ce] p-3 rounded text-[#f3e8ff]">
                <div className="flex items-center space-x-2 font-bold text-[#c084fc] mb-1">
                  <Cpu size={15} />
                  <span>GENERATIVE AI &amp; AUTONOMOUS PLANNING NOTICE</span>
                </div>
                Tier-1 Prompt Bar and CommandBus synthesis leverage probabilistic generative AI models and automated transaction planners.
              </div>
              <div className="space-y-2">
                <p>
                  <strong>1. Probabilistic Hallucination Warning:</strong> AI planners may propose invalid geometry, missing structural bounds, erroneous dimensions, or non-compliant architectural details.
                </p>
                <p>
                  <strong>2. Mandatory Human Verification:</strong> All AI-generated commands, previews, and parametric transaction proposals must be independently audited and validated by a qualified professional before commitment.
                </p>
                <p>
                  <strong>3. No Professional Agency:</strong> AI agents do not act as licensed design agents, and no agency relationship or professional duty of care is established.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'warranty' && (
            <div className="space-y-3">
              <div className="bg-[#064e3b] border border-[#059669] p-3 rounded text-[#a7f3d0]">
                <div className="flex items-center space-x-2 font-bold text-[#34d399] mb-1">
                  <ShieldAlert size={15} />
                  <span>GNU GENERAL PUBLIC LICENSE v3.0 — "AS IS"</span>
                </div>
                Sections 15 &amp; 16 Disclaimer of Warranties and Limitation of Liability.
              </div>
              <div className="font-mono text-[10px] bg-[#1a1a1a] p-3 rounded border border-[#333333] space-y-2 text-[#9ca3af]">
                <p>
                  THERE IS NO WARRANTY FOR THE PROGRAM, TO THE EXTENT PERMITTED BY APPLICABLE LAW. EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS PROVIDE THE PROGRAM "AS IS" WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.
                </p>
                <p>
                  IN NO EVENT SHALL ANY COPYRIGHT HOLDER OR CONTRIBUTOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING LOSS OF DATA, WORK STOPPAGE, OR LOSSES SUSTAINED BY THIRD PARTIES) ARISING OUT OF THE USE OR INABILITY TO USE THE PROGRAM.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#1e1e1e] border-t border-[#333333] shrink-0">
          <div className="text-[10px] text-[#71717a]">
            Detailed terms documented in <span className="text-[#38bdf8] font-mono">LEGAL.md</span> and <span className="text-[#38bdf8] font-mono">LICENSE</span>
          </div>
          <button
            onClick={() => setLegalModalOpen(false)}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#007acc] hover:bg-[#0062a3] text-white font-medium rounded transition-colors"
          >
            <CheckCircle2 size={13} />
            <span>Acknowledge &amp; Close</span>
          </button>
        </div>
      </div>
    </div>
  );
};
